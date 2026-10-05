'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-template-api-'));
let server, base;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const post = (p, token, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(json);
const upload = (token, obj) => { const fd = new FormData(); fd.append('template', new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj)], { type: 'application/json' }), 'x.haven-template.json'); return fetch(`${base}/api/admin/template/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }).then(json); };
const register = (username) => post('/api/auth/register', null, { username, password: 'templatetest123', eulaVersion: '2.0', ageVerified: true }).then((r) => r.body);
const template = {
  format: 'haven-server-template', version: 1, meta: { name: 'Book Club' },
  server: { settings: { server_name: 'Book Club', channel_sort_mode: 'manual', welcome_message: 'Welcome {user}' }, defaultJoinChannels: ['lobby'] },
  roles: [{ ref: 'host', name: 'Host', level: 40, color: '#aa3366', permissions: ['pin_message', 'set_channel_topic'] }],
  channels: [
    { ref: 'lobby', name: 'lobby', category: 'Club', topic: 'Say hi', welcome: true },
    { ref: 'reading', name: 'reading-now', category: 'Club', forum: true, forumTags: [{ name: 'Fiction' }] },
    { ref: 'hosts', name: 'hosts', category: 'Club', private: true, roleGate: { mode: 'any', roles: ['host'] } },
  ],
  posts: [{ channel: 'lobby', author: 'Club Bot', pinned: true, content: 'Read the pinned list.' }],
};
test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });
test('server templates over HTTP: admin only, preview, apply, live update', async () => {
  const admin = await register('admin');
  const member = await register('member');
  assert.ok(admin.token && member.token);
  assert.equal((await fetch(`${base}/api/admin/template/export`)).status, 403);
  assert.equal((await fetch(`${base}/api/admin/template/export`, { headers: { Authorization: `Bearer ${member.token}` } })).status, 403);
  assert.equal((await upload(member.token, template)).status, 403);
  assert.equal((await post('/api/admin/template/apply', member.token, { id: 'x' })).status, 403);
  const exp = await fetch(`${base}/api/admin/template/export`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /\.haven-template\.json/);
  const exported = await exp.json();
  assert.equal(exported.format, 'haven-server-template');
  assert.ok(!JSON.stringify(exported).includes(admin.token));
  const badJson = await upload(admin.token, '{nope');
  assert.equal(badJson.status, 400);
  const invalid = await upload(admin.token, { ...template, channels: [{ ref: 'x', name: '<b>' }] });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.details.some((d) => /channels\[0\]\.name/.test(d)));
  const up = await upload(admin.token, template);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.summary.channels, 3);
  assert.equal((await post('/api/admin/template/plan', member.token, { id: up.body.id })).status, 403);
  const plan = await post('/api/admin/template/plan', admin.token, { id: up.body.id, mode: 'replace' });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.created.channels, ['lobby', 'reading-now', 'hosts']);
  assert.equal(plan.body.dryRun, true);
  const sock = io(base, { auth: { token: member.token }, transports: ['websocket'], forceNew: true });
  await new Promise((r, j) => { sock.on('connect', r); sock.on('connect_error', j); });
  const listed = new Promise((r) => sock.on('channels-list', (list) => { if (list.some((c) => c.name === 'lobby')) r(list); }));
  const applied = await post('/api/admin/template/apply', admin.token, { id: up.body.id, mode: 'replace' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.dryRun, false);
  assert.equal(applied.body.counts.posts, 1);
  const list = await Promise.race([listed, new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(list, 'members get the new channel list without reloading');
  assert.ok(!list.some((c) => c.name === 'hosts'), 'the role-gated channel stays hidden from a member without the role');
  sock.close();
  assert.equal((await post('/api/admin/template/apply', admin.token, { id: up.body.id })).status, 404, 'an upload is used once');
});

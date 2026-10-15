/**
 * Channel rules from the October 2026 security review:
 * - a private channel is joined by being added, never by its code;
 * - a server-wide permission does not reach into channels you are not in;
 * - moderators get no invite codes in the member list;
 * - nobody is kicked out of a one to one DM.
 *
 *   node --test test/channelRules.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');

const PORT = 3416;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-channel-rules-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) =>
  post('/api/auth/register', { username, password: 'channeltest123', eulaVersion: '2.0', ageVerified: true });
const clients = [];
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
const readDb = (sql, ...args) => {
  const db = new Database(path.join(DATA, 'haven.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const ack = (sock, event, data) => new Promise((r) => sock.emit(event, data, r));

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});
test.after(async () => {
  clients.forEach((s) => s.close());
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('private channels, channel settings, member lists and DM kicks follow the rules', async () => {
  const admin = await register('admin');
  const mod = await register('mod');
  const bob = await register('bob');
  const A = await connect(admin.token), M = await connect(mod.token), B = await connect(bob.token);
  await wait(300);

  const made = await ack(A, 'create-role', { name: 'Warden', level: 60, permissions: ['kick_user', 'ban_user', 'manage_channel_settings'] });
  assert.ok(made && !made.error, JSON.stringify(made));
  const warden = readDb("SELECT id FROM roles WHERE name = 'Warden'")[0].id;
  const given = await ack(A, 'assign-role', { userId: mod.user.id, roleId: warden });
  assert.ok(given && given.success, JSON.stringify(given));

  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'secret'));
  A.emit('create-channel', { name: 'secret', isPrivate: true });
  const secret = (await list).find((c) => c.name === 'secret');
  assert.ok(secret && secret.code, 'private channel made');
  await wait(300);
  const secretId = readDb('SELECT id FROM channels WHERE code = ?', secret.code)[0].id;
  const inSecret = (u) => readDb('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', secretId, u.user.id).length > 0;

  // The code alone does not get anyone into a private channel.
  M.emit('join-channel', { code: secret.code });
  await wait(400);
  assert.strictEqual(inSecret(mod), false, 'a code does not open a private channel');

  // Channel settings permission does not reach a channel the mod is not in.
  M.emit('set-channel-expiry', { code: secret.code, hours: 1, mode: 'delete' });
  await wait(300);
  assert.strictEqual(readDb('SELECT expires_at FROM channels WHERE id = ?', secretId)[0].expires_at, null, 'no deletion timer from outside');

  // The member list a moderator gets has no invite codes and no channels they cannot see.
  const members = await ack(M, 'get-all-members', {});
  assert.ok(members && !members.error, JSON.stringify(members && members.error));
  const listed = JSON.stringify(members);
  assert.ok(!listed.includes(secret.code), 'no private channel code');
  for (const c of members.allChannels || []) assert.strictEqual(c.code, undefined, 'no codes for moderators');
  assert.ok(!(members.allChannels || []).some((c) => c.id === secretId), 'the private channel is not listed');

  // Nobody kicks the other person out of a one to one DM, the admin included.
  const opened = next(A, 'dm-opened');
  A.emit('start-dm', { targetUserId: bob.user.id });
  const dm = await opened;
  assert.ok(dm && dm.code, 'DM opened');
  await wait(300);
  A.emit('enter-channel', { code: dm.code });
  await wait(300);
  A.emit('kick-user', { userId: bob.user.id });
  await wait(400);
  const dmId = readDb('SELECT id FROM channels WHERE code = ?', dm.code)[0].id;
  assert.ok(readDb('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', dmId, bob.user.id).length, 'bob stays in the DM');

  // The admin reads nobody else's DM.
  const theirs = next(M, 'dm-opened');
  M.emit('start-dm', { targetUserId: bob.user.id });
  const modDm = await theirs;
  assert.ok(modDm && modDm.code, 'mod and bob have a DM');
  await wait(300);
  const err = next(A, 'error-msg', (m) => /member/i.test(String(m)));
  const history = next(A, 'message-history', (h) => h && h.channelCode === modDm.code, 1500);
  A.emit('get-messages', { code: modDm.code });
  assert.ok(await err, 'the admin is refused');
  assert.strictEqual(await history, null, 'and gets no history');
});

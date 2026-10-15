/**
 * Access rules from the October 2026 security review:
 * - nobody below the admin hands out a role carrying permissions they lack,
 *   by assigning it or through a role menu;
 * - an anonymous poll sends nobody else's name or id;
 * - in a DM each person deletes only their own messages, the admin included.
 *
 *   node --test test/accessRules.test.js
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

const PORT = 3415;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-access-rules-${Date.now()}`);

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
  post('/api/auth/register', { username, password: 'grouptest123', eulaVersion: '2.0', ageVerified: true });
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
const jwk = (x) => ({ kty: 'EC', crv: 'P-256', x, y: `y${x}` });
const epochFor = (users) => ({
  keys: users.map((u) => ({ recipientId: u.user.id, wrappedKey: JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: `w${u.user.id}` }) })),
  sig: 'c2lnbmVk',
  roster: users.map((u) => ({ id: u.user.id, ecdhJwk: jwk(`e${u.user.id}`), signJwk: jwk(`s${u.user.id}`) })),
});

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


const ack = (sock, event, data) => new Promise((r) => sock.emit(event, data, r));

test('role hand-outs, anonymous polls and DM deletes follow the rules', async () => {
  const admin = await register('admin');
  const mod = await register('mod');
  const bob = await register('bob');
  const A = await connect(admin.token), M = await connect(mod.token), B = await connect(bob.token);
  await wait(300);

  // A role that may hand out roles, and two lower ones: one plain, one with Manage Server.
  const lead = await ack(A, 'create-role', { name: 'Lead', level: 60, permissions: ['promote_user', 'manage_roles'] });
  assert.ok(lead && !lead.error, JSON.stringify(lead));
  await ack(A, 'create-role', { name: 'Fan', level: 5, permissions: [] });
  await ack(A, 'create-role', { name: 'Helper', level: 10, permissions: ['manage_server'] });
  const roleId = (n) => readDb('SELECT id FROM roles WHERE name = ?', n)[0].id;
  const made = await ack(A, 'assign-role', { userId: mod.user.id, roleId: roleId('Lead') });
  assert.ok(made && made.success, JSON.stringify(made));
  await wait(300);

  const fan = await ack(M, 'assign-role', { userId: bob.user.id, roleId: roleId('Fan') });
  assert.ok(fan && fan.success, 'a plain lower role can be handed out: ' + JSON.stringify(fan));
  const helper = await ack(M, 'assign-role', { userId: bob.user.id, roleId: roleId('Helper') });
  assert.match(helper.error || '', /permissions you do not have/, 'not one carrying Manage Server');
  const general = readDb("SELECT code FROM channels WHERE is_dm = 0 ORDER BY id LIMIT 1")[0];
  if (general) {
    const menu = await ack(M, 'create-role-menu', { code: general.code, title: 'Pick', roles: [{ roleId: roleId('Helper'), emoji: '🛠️' }] });
    assert.match(menu.error || '', /permissions you do not have/, 'nor through a role menu');
  }

  // Anonymous poll: other people's votes carry no names or ids.
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'polls'));
  A.emit('create-channel', { name: 'polls' });
  const polls = (await list).find((c) => c.name === 'polls');
  B.emit('join-channel', { code: polls.code });
  M.emit('join-channel', { code: polls.code });
  await wait(400);
  for (const s of [A, B, M]) s.emit('enter-channel', { code: polls.code });
  await wait(300);
  A.emit('create-poll', { code: polls.code, question: 'Pizza?', options: ['yes', 'no'], anonymous: true });
  await wait(500);
  const pollMsg = readDb("SELECT id FROM messages WHERE poll_data IS NOT NULL ORDER BY id DESC LIMIT 1")[0];
  const seenByMod = next(M, 'poll-updated', (d) => d && d.messageId === pollMsg.id);
  B.emit('vote-poll', { messageId: pollMsg.id, optionIndex: 0 });
  const update = await seenByMod;
  assert.ok(update, 'the vote was broadcast');
  assert.deepStrictEqual(update.votes[0], [{ user_id: 0, username: '' }], 'counted, but nameless');

  // DM: the admin cannot delete bob's message in their DM.
  const opened = next(A, 'dm-opened');
  A.emit('start-dm', { targetUserId: bob.user.id });
  const dm = await opened;
  assert.ok(dm && dm.code, 'DM opened');
  await wait(300);
  B.emit('enter-channel', { code: dm.code });
  await wait(200);
  B.emit('send-message', { code: dm.code, content: 'from bob' });
  await wait(400);
  const bobMsg = readDb("SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.code = ? AND m.user_id = ?", dm.code, bob.user.id)[0];
  assert.ok(bobMsg, 'bob wrote in the DM');
  A.emit('delete-message', { messageId: bobMsg.id, channelCode: dm.code });
  await wait(400);
  assert.ok(readDb('SELECT 1 FROM messages WHERE id = ?', bobMsg.id).length, 'bob\'s DM message stays');
});

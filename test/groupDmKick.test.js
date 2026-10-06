/**
 * Kicking someone from a group DM (#5740).
 *
 * The regular channel kick only deleted the membership: the kicked person
 * kept the group on screen, and the members still in it were never told, so
 * they kept a stale member list and went on using a key the kicked person
 * holds. A kick from a group DM now works like leaving it.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/groupDmKick.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3403;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-group-kick-${Date.now()}`);

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
// Every client, so a failed test still closes them and the run can end.
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
  // The data folder can only go once the server has let go of its files.
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

let adminToken;

test('a kick from a group DM removes the group for the kicked person and makes the rest replace the key', async () => {
  const admin = await register('admin');
  adminToken = admin.token;
  const bob = await register('bob');
  const carol = await register('carol');
  const dave = await register('dave');
  const A = await connect(admin.token);
  const B = await connect(bob.token);
  const C = await connect(carol.token);
  const D = await connect(dave.token);
  for (const [sock, tag] of [[A, 'a'], [B, 'b'], [C, 'c'], [D, 'd']]) {
    sock.emit('publish-public-key', { jwk: jwk(tag) });
    sock.emit('publish-signing-key', { jwk: jwk(`s${tag}`) });
  }
  await wait(600);

  const opened = next(A, 'group-dm-opened');
  A.emit('start-group-dm', { userIds: [bob.user.id, carol.user.id, dave.user.id], name: 'Crew' });
  const { code } = await opened;
  for (const S of [B, C, D]) {
    const joined = next(S, 'group-dm-opened');
    S.emit('accept-group-dm', { code });
    assert.ok(await joined);
  }
  const published = next(A, 'group-epoch-published');
  A.emit('publish-group-epoch', { code, epoch: 1, ...epochFor([admin, bob, carol, dave]) });
  assert.ok(await published);
  A.emit('enter-channel', { code });
  await wait(300);

  const kicked = next(B, 'kicked', (d) => d && d.channelCode === code);
  const deleted = next(B, 'channel-deleted', (d) => d && d.code === code);
  const bobList = next(B, 'channels-list', (chs) => Array.isArray(chs) && !chs.some((c) => c.code === code));
  const told = next(C, 'group-dm-member-left', (d) => d && d.code === code);
  const toast = next(A, 'toast', (d) => d && /Kicked bob/.test(d.message));
  A.emit('kick-user', { userId: bob.user.id });

  const k = await kicked;
  assert.ok(k, 'bob hears he was kicked');
  assert.strictEqual(k.group, true, 'from the group, not the server');
  assert.ok(await deleted, 'the group is gone from bob\'s app right away');
  assert.ok(await bobList, 'and from his channel list');
  const left = await told;
  assert.ok(left, 'the members still in the group are told');
  assert.strictEqual(left.user.id, bob.user.id);
  assert.deepStrictEqual(left.members.map((m) => m.id).sort(), [admin, carol, dave].map((u) => u.user.id).sort());
  assert.ok(await toast, 'the kicker still gets the success toast');

  const keys = next(C, 'group-keys', (d) => d && d.code === code);
  C.emit('get-group-keys', { code, sinceEpoch: 0 });
  assert.strictEqual((await keys).needsRotation, true, 'the key bob holds must be replaced');

  const refused = next(B, 'error-msg');
  B.emit('get-group-keys', { code, sinceEpoch: 0 });
  assert.ok(await refused, 'bob can no longer read the group keys');

  [A, B, C, D].forEach((s) => s.close());
});

test('a kick from a regular channel still works as before', async () => {
  const erin = await register('erin');
  const A = await connect(adminToken);
  const list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'lounge'));
  A.emit('create-channel', { name: 'lounge' });
  const ch = (await list).find((c) => c.name === 'lounge');
  A.emit('enter-channel', { code: ch.code });
  const E = await connect(erin.token);
  E.emit('join-channel', { code: ch.code });
  await wait(300);
  E.emit('enter-channel', { code: ch.code });
  await wait(300);
  try {
    const kicked = next(E, 'kicked', (d) => d && d.channelCode === ch.code);
    const notice = next(A, 'new-message', (d) => d && d.channelCode === ch.code && /erin was kicked/.test(d.message.content));
    A.emit('kick-user', { userId: erin.user.id });
    const k = await kicked;
    assert.ok(k, 'erin hears she was kicked');
    assert.ok(!k.group, 'from the channel, not a group');
    assert.ok(await notice, 'the channel hears it');
  } finally {
    [A, E].forEach((s) => s.close());
  }
});

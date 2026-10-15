/**
 * A role-gated channel's live messages reach only people its gate lets in.
 * Entering its code used to put anyone into its room, so they received every
 * new message there even though the channel stayed hidden from them.
 *
 *   node --test test/roleGateRooms.test.js
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

const PORT = 3410;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-gate-rooms-${Date.now()}`);

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


test('entering a gated channel\'s code does not stream its messages', async () => {
  const admin = await register('admin');
  const bob = await register('bob');
  const A = await connect(admin.token), B = await connect(bob.token);
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'staff'));
  A.emit('create-channel', { name: 'staff' });
  const staff = (await list).find((c) => c.name === 'staff');
  const modRole = readDb("SELECT id FROM roles WHERE name = 'Mod'")[0];
  const gated = await new Promise((r) => A.emit('set-channel-role-gate', { code: staff.code, mode: 'any', roles: [modRole.id] }, r));
  assert.ok(gated && !gated.error, 'gate set: ' + JSON.stringify(gated));
  await wait(300);

  B.emit('join-channel', { code: staff.code });
  await wait(500);
  const leaked = next(B, 'new-message', (d) => d && d.channelCode === staff.code, 1500);
  A.emit('enter-channel', { code: staff.code });
  await wait(200);
  A.emit('send-message', { code: staff.code, content: 'staff only' });
  assert.strictEqual(await leaked, null, 'bob, without the role, got nothing');
});

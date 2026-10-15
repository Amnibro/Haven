/**
 * Key lookups have their own rate limit.
 *
 * Opening a group DM with history from before you joined made one key lookup
 * per locked message. Those counted against the general allowance of 60
 * events per 10 seconds, so the member got "Slow down: too many requests"
 * and their own sends were dropped along with the lookups. Read-only key
 * lookups now have a separate allowance, and a request dropped over any limit
 * is answered with `rate_limited` when the caller waits on an ack.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/keyLookupFlood.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3470;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-key-flood-${Date.now()}`);

let server;
const clients = [];

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) =>
  post('/api/auth/register', { username, password: 'floodtest123', eulaVersion: '2.0', ageVerified: true });
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
// Count the replies to `n` copies of an event sent at once.
async function burst(sock, n, event, payload, reply) {
  let got = 0;
  const h = () => { got++; };
  sock.on(reply, h);
  for (let i = 0; i < n; i++) sock.emit(event, payload);
  await wait(1500);
  sock.off(reply, h);
  return got;
}

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
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('a burst of key lookups leaves the general allowance untouched', async () => {
  const u = await register('keyreader');
  const s = await connect(u.token);
  const slow = [];
  s.on('error-msg', (m) => slow.push(m));
  // More lookups than the general bucket allows in a window.
  assert.strictEqual(await burst(s, 100, 'get-public-key', { userId: u.user.id }, 'public-key-result'), 100);
  assert.deepStrictEqual(slow, []);
  // Ordinary events still go through in the same window.
  assert.strictEqual(await burst(s, 20, 'ping-check', undefined, 'pong-check'), 20);
});

test('key lookups are still limited, with one warning', async () => {
  const u = await register('keyflooder');
  const s = await connect(u.token);
  const slow = [];
  s.on('error-msg', (m) => slow.push(m));
  const answered = await burst(s, 200, 'get-signing-key', { userId: u.user.id }, 'signing-key-result');
  assert.ok(answered >= 100 && answered < 200, `some lookups were refused (${answered} answered)`);
  assert.deepStrictEqual(slow, ['Slow down: too many requests']);
});

test('a request dropped over the limit is answered rate_limited when it waits on an ack', async () => {
  const u = await register('ackwaiter');
  const s = await connect(u.token);
  for (let i = 0; i < 80; i++) s.emit('ping-check');
  await wait(300);
  const reply = await new Promise((res) => {
    const t = setTimeout(() => res('timed out'), 3000);
    s.emit('get-all-members', {}, (r) => { clearTimeout(t); res(r); });
  });
  assert.deepStrictEqual(reply, { ok: false, error: 'rate_limited' });
});

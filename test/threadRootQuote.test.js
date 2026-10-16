/**
 * A thread reply that names the thread's own first message as the message it
 * replies to only repeats what sits at the top of the thread, so outside
 * forums the server leaves that quote off. A reply to another reply keeps it.
 *
 *   node --test test/threadRootQuote.test.js
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

const PORT = 3417;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-thread-root-quote-${Date.now()}`);

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


test('a thread reply that quotes the thread start is stored without the quote', async () => {
  const admin = await register('admin'), bob = await register('bob');
  const A = await connect(admin.token), B = await connect(bob.token);
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'talk'));
  A.emit('create-channel', { name: 'talk' });
  const code = (await list).find((c) => c.name === 'talk').code;
  B.emit('join-channel', { code });
  await wait(300);
  A.emit('enter-channel', { code }); B.emit('enter-channel', { code });
  await wait(200);
  A.emit('send-message', { code, content: 'thread start' });
  await wait(400);
  const root = readDb("SELECT id FROM messages WHERE content = 'thread start'")[0];
  assert.ok(root);
  await new Promise((r) => B.emit('send-thread-message', { parentId: root.id, content: 'first reply', replyTo: root.id }, r));
  await wait(300);
  const first = readDb("SELECT id, thread_id, reply_to FROM messages WHERE content = 'first reply'")[0];
  assert.equal(first.thread_id, root.id, 'it is still in the thread');
  assert.equal(first.reply_to, null, 'with no quote of the thread start');
  await new Promise((r) => A.emit('send-thread-message', { parentId: root.id, content: 'answer', replyTo: first.id }, r));
  await wait(300);
  assert.equal(readDb("SELECT reply_to FROM messages WHERE content = 'answer'")[0].reply_to, first.id, 'a reply to another reply keeps its quote');
});

/**
 * Deleting a message takes its thread replies with it (a forum topic and its
 * replies, a blog gallery and every picture in it), and their files leave the
 * uploads folder too, each author's own, as with any delete (#5783).
 *
 *   node --test test/threadReplyFiles.test.js
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

const PORT = 3407;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-thread-files-${Date.now()}`);

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


// A small PNG, uploaded the way the app uploads a picture.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex');
async function upload(token) {
  const fd = new FormData();
  fd.append('scope', 'channel');
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'pic.png');
  const r = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const j = await r.json();
  assert.ok(j.url, 'uploaded: ' + JSON.stringify(j));
  return j.url;
}
const inUploads = (url) => fs.existsSync(path.join(DATA, 'uploads', url.replace('/uploads/', '')));

test('deleting a topic moves its replies\' files out of uploads', async () => {
  const admin = await register('admin');
  const bob = await register('bob');
  const A = await connect(admin.token), B = await connect(bob.token);
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'gallery'));
  A.emit('create-channel', { name: 'gallery' });
  const code = (await list).find((c) => c.name === 'gallery').code;
  B.emit('join-channel', { code });
  await wait(300);
  A.emit('enter-channel', { code }); B.emit('enter-channel', { code });
  await wait(200);

  const topicPic = await upload(admin.token);
  const replyPic = await upload(admin.token);
  const bobPic = await upload(bob.token);
  A.emit('send-message', { code, content: `A gallery\n${topicPic}` });
  await wait(400);
  const topic = readDb("SELECT id FROM messages WHERE content LIKE 'A gallery%'")[0];
  assert.ok(topic);
  await new Promise((r) => A.emit('send-thread-message', { parentId: topic.id, content: replyPic }, r));
  await new Promise((r) => B.emit('send-thread-message', { parentId: topic.id, content: `nice\n${bobPic}` }, r));
  await wait(300);
  assert.ok(inUploads(replyPic) && inUploads(bobPic));

  A.emit('delete-message', { messageId: topic.id, channelCode: code });
  await wait(600);
  assert.equal(readDb('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', topic.id)[0].n, 0, 'the replies went with it');
  assert.ok(!inUploads(topicPic), "the topic's own picture left uploads");
  assert.ok(!inUploads(replyPic), "a reply's picture left uploads");
  assert.ok(!inUploads(bobPic), "another member's reply picture left uploads too");
  assert.ok(fs.existsSync(path.join(DATA, 'uploads', 'deleted-attachments', replyPic.replace('/uploads/', ''))), 'and waits in deleted-attachments');
});

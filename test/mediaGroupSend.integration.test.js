/**
 * Pictures sent together arrive as one message (#5799): the server takes a
 * message with several upload lines, refuses one with too many, applies the
 * channel's text and media switches to every line, and a delete takes every
 * file with it.
 *
 *   node --test test/mediaGroupSend.integration.test.js
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

const PORT = 3489;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-media-group-${Date.now()}`);

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
const writeDb = (sql, ...args) => {
  const db = new Database(path.join(DATA, 'haven.db'), { fileMustExist: true });
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
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
async function uploads(token, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await upload(token));
  return out;
}
const inUploads = (url) => fs.existsSync(path.join(DATA, 'uploads', url.replace('/uploads/', '')));

let ctx = null;
async function setup() {
  if (ctx) return ctx;
  const admin = await register('admin'), bob = await register('bob');
  const A = await connect(admin.token), B = await connect(bob.token);
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'photos'));
  A.emit('create-channel', { name: 'photos' });
  const code = (await list).find((c) => c.name === 'photos').code;
  B.emit('join-channel', { code });
  await wait(300);
  A.emit('enter-channel', { code }); B.emit('enter-channel', { code });
  await wait(200);
  ctx = { admin, bob, A, B, code };
  return ctx;
}
const lastMessage = (code) => readDb(
  'SELECT m.id, m.content FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.code = ? AND m.thread_id IS NULL ORDER BY m.id DESC LIMIT 1', code)[0];

test('ten pictures and their text arrive as one message', async () => {
  const { admin, A, B, code } = await setup();
  const pics = await uploads(admin.token, 10);
  const arrived = next(A, 'new-message', (d) => d.channelCode === code && d.message.content.startsWith('Ten at once'));
  B.emit('send-message', { code, content: ['Ten at once', ...pics].join('\n') });
  const got = await arrived;
  assert.ok(got, 'the grouped message was broadcast');
  assert.deepEqual(got.message.content.split('\n').slice(1), pics);
  assert.equal(lastMessage(code).content, ['Ten at once', ...pics].join('\n'));
});

test('eleven files in one message are refused, nothing is stored', async () => {
  const { admin, A, B, code } = await setup();
  const before = lastMessage(code).id;
  const pics = await uploads(admin.token, 11);
  const err = next(B, 'error-msg', (m) => /attachments/.test(m));
  B.emit('send-message', { code, content: pics.join('\n'), isImage: true });
  assert.match(await err, /^Too many attachments in one message \(max 10\)$/);
  await wait(200);
  assert.equal(lastMessage(code).id, before);
});

test('the admin setting lowers the count, and text at the limit still takes its pictures', async () => {
  const { admin, A, B, code } = await setup();
  writeDb("INSERT INTO server_settings (key, value) VALUES ('max_attachments', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  try {
    const pics = await uploads(admin.token, 4);
    const err = next(B, 'error-msg', (m) => /attachments/.test(m));
    B.emit('send-message', { code, content: pics.join('\n') });
    assert.match(await err, /max 3/);

    const text = 'y'.repeat(2000);
    B.emit('send-message', { code, content: [text, ...pics.slice(0, 3)].join('\n') });
    await wait(400);
    assert.equal(lastMessage(code).content, [text, ...pics.slice(0, 3)].join('\n'));

    const tooLong = next(B, 'error-msg', (m) => /too long/.test(m));
    B.emit('send-message', { code, content: [text + 'y', pics[3]].join('\n') });
    assert.ok(await tooLong, 'the typed part is still held to the limit');
  } finally {
    writeDb("UPDATE server_settings SET value = '10' WHERE key = 'max_attachments'");
  }
});

test('a channel with media off refuses text that carries a picture on any line', async () => {
  const { admin, A, B } = await setup();
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'words'));
  A.emit('create-channel', { name: 'words' });
  const code = (await list).find((c) => c.name === 'words').code;
  A.emit('toggle-channel-permission', { code, permission: 'media' });
  B.emit('join-channel', { code });
  await wait(300);
  B.emit('enter-channel', { code });
  await wait(200);
  const [p] = await uploads(admin.token, 1);
  const err = next(B, 'error-msg', (m) => /Media uploads are disabled/.test(m));
  B.emit('send-message', { code, content: `hello\n${p}` });
  assert.ok(await err, 'a picture under text is still a picture');
});

test('a channel with text off takes pictures together but not text with them', async () => {
  const { admin, A, B } = await setup();
  const list = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'gallery-only'));
  A.emit('create-channel', { name: 'gallery-only' });
  const code = (await list).find((c) => c.name === 'gallery-only').code;
  A.emit('toggle-channel-permission', { code, permission: 'text' });
  B.emit('join-channel', { code });
  await wait(300);
  B.emit('enter-channel', { code });
  await wait(200);
  const pics = await uploads(admin.token, 3);
  B.emit('send-message', { code, content: pics.join('\n'), isImage: true });
  await wait(400);
  assert.equal(lastMessage(code).content, pics.join('\n'));
  const err = next(B, 'error-msg', (m) => /Text messages are disabled/.test(m));
  B.emit('send-message', { code, content: `caption\n${pics[0]}` });
  assert.ok(await err);
});

test('a thread reply carries several pictures, with the same count limit', async () => {
  const { admin, A, code } = await setup();
  A.emit('send-message', { code, content: 'thread starter' });
  await wait(300);
  const parent = lastMessage(code);
  const pics = await uploads(admin.token, 11);
  const ok = await new Promise((r) => A.emit('send-thread-message', { parentId: parent.id, content: ['some shots', ...pics.slice(0, 4)].join('\n') }, r));
  assert.deepEqual(ok, { success: true });
  const reply = readDb('SELECT content FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1', parent.id)[0];
  assert.equal(reply.content, ['some shots', ...pics.slice(0, 4)].join('\n'));
  const err = next(A, 'error-msg', (m) => /attachments/.test(m));
  A.emit('send-thread-message', { parentId: parent.id, content: pics.join('\n') }, () => {});
  assert.match(await err, /max 10/);
});

test('deleting a grouped message moves every one of its files out of uploads', async () => {
  // Only the author's own files go with a delete, so the uploader sends it.
  const { admin, A, code } = await setup();
  const pics = await uploads(admin.token, 4);
  A.emit('send-message', { code, content: ['to delete', ...pics].join('\n') });
  await wait(400);
  const msg = lastMessage(code);
  assert.ok(msg.content.startsWith('to delete'));
  assert.ok(pics.every(inUploads));
  A.emit('delete-message', { messageId: msg.id, channelCode: code });
  await wait(500);
  assert.equal(readDb('SELECT COUNT(*) AS n FROM messages WHERE id = ?', msg.id)[0].n, 0);
  for (const p of pics) assert.ok(!inUploads(p), `${p} left uploads`);
});

test('editing a grouped message keeps the text limit on the typed part only', async () => {
  const { admin, A, B, code } = await setup();
  const pics = await uploads(admin.token, 2);
  B.emit('send-message', { code, content: ['before', ...pics].join('\n') });
  await wait(400);
  const msg = lastMessage(code);
  const edited = next(B, 'message-edited', (d) => d.messageId === msg.id);
  B.emit('edit-message', { messageId: msg.id, channelCode: code, content: ['z'.repeat(2000), ...pics].join('\n') });
  assert.ok(await edited, 'text at the limit plus its pictures can be saved');
  const err = next(B, 'error-msg', (m) => /too long/.test(m));
  B.emit('edit-message', { messageId: msg.id, channelCode: code, content: ['z'.repeat(2001), ...pics].join('\n') });
  assert.ok(await err);
});

test('each picture keeps its own tags, in the message, the gallery and a gallery edit', async () => {
  const { admin, A, code } = await setup();
  const pics = await uploads(admin.token, 3);
  const arrived = next(A, 'new-message', (d) => d.channelCode === code && d.message.content.startsWith('tagged'));
  A.emit('send-message', {
    code,
    content: ['tagged', ...pics].join('\n'),
    mediaTags: [{ url: pics[0], tags: ['cat'] }, { url: pics[2], tags: ['dog', 'park'] }],
  });
  const got = await arrived;
  assert.deepEqual([...got.message.attachmentTags].sort(), ['cat', 'dog', 'park']);
  const id = got.message.id;
  const tagsOf = (url) => readDb(
    'SELECT ut.name FROM attachment_tags at JOIN upload_tags ut ON ut.id = at.tag_id WHERE at.message_id = ? AND at.rel_path = ? ORDER BY ut.name_norm', id, url,
  ).map((r) => r.name);
  assert.deepEqual(tagsOf(pics[0]), ['cat']);
  assert.deepEqual(tagsOf(pics[1]), []);
  assert.deepEqual(tagsOf(pics[2]), ['dog', 'park']);

  const media = next(A, 'channel-media', (d) => d.channelCode === code);
  A.emit('get-channel-media', { code });
  const photos = (await media).photos.filter((p) => p.message_id === id);
  assert.deepEqual(photos.map((p) => p.url).sort(), [...pics].sort(), 'the gallery lists every picture');
  assert.deepEqual(photos.find((p) => p.url === pics[2]).tags, ['dog', 'park']);

  const res = await new Promise((r) => A.emit('bulk-tag-messages', { code, mode: 'replace', tags: ['bird'], items: [{ messageId: id, url: pics[1] }] }, r));
  assert.deepEqual(res.results, [{ messageId: id, url: pics[1], tags: ['bird'] }]);
  assert.deepEqual(tagsOf(pics[0]), ['cat'], 'the other pictures keep theirs');
  assert.deepEqual(tagsOf(pics[1]), ['bird']);
});

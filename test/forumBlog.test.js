/**
 * Blog mode for forums (#5742): a per-forum switch. With it on, the topic
 * author's own follow-ups are part of the post and everyone else's replies
 * are comments; the cards count only the comments. The server decides which
 * is which from the account that wrote each reply.
 *
 * Boots its own Haven server on a scratch port and data dir.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3439;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-forumblog-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const register = (username) => post('/api/auth/register', { username, password: 'blogtest123', eulaVersion: '2.0', ageVerified: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}

function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}

function history(sock, code) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code });
  return p;
}

function thread(sock, parentId) {
  const p = next(sock, 'thread-messages', (d) => d && d.parentId === parentId);
  sock.emit('get-thread-messages', { parentId });
  return p;
}

const reply = (sock, parentId, content, replyTo) => new Promise((res) => sock.emit('send-thread-message', { parentId, content, replyTo }, res));

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
  // Wait for the server to let go of its database before removing the dir.
  if (server && server.exitCode === null) { const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone; }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (err) { console.warn('[forumBlog test] could not remove the scratch data dir:', err.message); }
});

test('blog mode on forum topics', async (t) => {
  const admin = await register('admin');
  const bob = await register('bob');
  assert.ok(admin.token && bob.token, 'accounts registered');
  const A = await connect(admin.token);
  const B = await connect(bob.token);

  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'gallery'));
  A.emit('create-channel', { name: 'gallery' });
  const code = (await list).find((c) => c.name === 'gallery').code;
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 1));
  A.emit('toggle-channel-permission', { code, permission: 'forum' });
  assert.ok(await list, 'forum mode on');
  A.emit('enter-channel', { code });
  B.emit('join-channel', { code });
  await wait(200);
  B.emit('enter-channel', { code });
  await wait(200);

  // Bob starts a topic: starting topics is the same in blog mode.
  B.emit('send-message', { code, content: 'my trip', title: 'Trip photos' });
  await wait(200);
  const topic = (await history(B, code)).messages.find((m) => m.content === 'my trip');
  assert.ok(topic, 'topic posted');

  // Bob adds to his post, the admin comments, and Bob answers the comment
  // (still Bob adding to his post: only who wrote a reply counts).
  await reply(B, topic.id, 'day two');
  await reply(A, topic.id, 'nice shots');
  const before = await thread(B, topic.id);
  const comment = before.messages.find((m) => m.content === 'nice shots');
  await reply(B, topic.id, 'thanks!', comment.id);

  await t.test('off by default: no blog fields at all', async () => {
    const th = await thread(A, topic.id);
    assert.strictEqual(th.blog, false);
    assert.ok(th.messages.every((m) => !('post_part' in m)), 'no reply is marked');
    const card = (await history(A, code)).messages.find((m) => m.id === topic.id);
    assert.strictEqual(card.thread.count, 3);
    assert.strictEqual(card.thread.comments, undefined, 'no comment count on the card');
  });

  await t.test('only someone who can change the channel settings turns it on', async () => {
    const refused = next(B, 'error-msg');
    B.emit('toggle-channel-permission', { code, permission: 'forum_blog' });
    assert.ok(await refused, 'a member is refused');
    const seen = next(B, 'channel-permission-updated', (d) => d && d.code === code && d.permission === 'forum_blog');
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.forum_blog === 1));
    A.emit('toggle-channel-permission', { code, permission: 'forum_blog' });
    assert.ok(await list, 'the channel list carries the setting');
    assert.strictEqual((await seen).enabled, true, 'members in the forum hear about it');
  });

  await t.test('the author\'s follow-ups are the post, everyone else comments', async () => {
    const th = await thread(A, topic.id);
    assert.strictEqual(th.blog, true);
    const parts = Object.fromEntries(th.messages.map((m) => [m.content, m.post_part]));
    assert.deepStrictEqual(parts, { 'day two': true, 'nice shots': false, 'thanks!': true },
      'only who wrote a reply counts');
    const card = (await history(A, code)).messages.find((m) => m.id === topic.id);
    assert.strictEqual(card.thread.comments, 1, 'the card counts the comments');
    assert.strictEqual(card.thread.count, 3, 'the reply count is unchanged');
  });

  await t.test('live: new replies carry the server\'s verdict and the comment count', async () => {
    let msg = next(A, 'new-thread-message', (d) => d && d.parentId === topic.id);
    let upd = next(A, 'thread-updated', (d) => d && d.parentId === topic.id);
    await reply(B, topic.id, 'day three');
    assert.strictEqual((await msg).message.post_part, true);
    assert.strictEqual((await upd).thread.comments, 1);

    msg = next(B, 'new-thread-message', (d) => d && d.parentId === topic.id);
    upd = next(B, 'thread-updated', (d) => d && d.parentId === topic.id);
    await reply(A, topic.id, 'post more!');
    assert.strictEqual((await msg).message.post_part, false);
    assert.strictEqual((await upd).thread.comments, 2);
  });

  await t.test('a client cannot claim a reply is part of the post', async () => {
    const msg = next(B, 'new-thread-message', (d) => d && d.parentId === topic.id);
    await new Promise((res) => A.emit('send-thread-message', { parentId: topic.id, content: 'sneaky', post_part: true, user_id: topic.user_id }, res));
    assert.strictEqual((await msg).message.post_part, false);
  });

  await t.test('a bot reply is a comment, whatever name it uses', async () => {
    const created = next(A, 'webhook-created', (w) => w && w.name === 'bob');
    A.emit('create-webhook', { channelCode: code, name: 'bob' });
    const hook = await created;
    assert.ok(hook && hook.token, 'webhook made');
    const upd = next(A, 'thread-updated', (d) => d && d.parentId === topic.id);
    const r = await post(`/api/webhooks/${hook.token}`, { content: 'bot says hi', username: 'bob', thread_id: topic.id });
    assert.ok(r.success, 'bot posted');
    assert.strictEqual((await upd).thread.comments, 4);
    const th = await thread(A, topic.id);
    assert.strictEqual(th.messages.find((m) => m.content === 'bot says hi').post_part, false);
  });

  await t.test('moderators still delete comments, and the count follows', async () => {
    const th = await thread(A, topic.id);
    const target = th.messages.find((m) => m.content === 'nice shots');
    const gone = next(B, 'message-deleted', (d) => d && d.messageId === target.id);
    A.emit('delete-message', { messageId: target.id });
    assert.ok(await gone, 'comment deleted');
    const card = (await history(A, code)).messages.find((m) => m.id === topic.id);
    assert.strictEqual(card.thread.comments, 3);
    const after = await thread(A, topic.id);
    assert.strictEqual(after.messages.find((m) => m.content === 'thanks!').post_part, true, 'the author\'s answer to it stays with the post');
  });

  await t.test('turning it off puts everything back', async () => {
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.forum_blog === 0));
    A.emit('toggle-channel-permission', { code, permission: 'forum_blog' });
    assert.ok(await list, 'off again');
    const th = await thread(A, topic.id);
    assert.strictEqual(th.blog, false);
    assert.ok(th.messages.every((m) => !('post_part' in m)));
  });

  for (const s of [A, B]) s.close();
});

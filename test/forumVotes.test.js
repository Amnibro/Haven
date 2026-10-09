/**
 * Votes on forum topics (#5742): a per-forum switch (off, likes, likes and
 * dislikes), one vote per person per topic, live counts for everyone in the
 * forum, and the Most liked order.
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

const PORT = 3438;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-forumvotes-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const register = (username) => post('/api/auth/register', { username, password: 'votetest123', eulaVersion: '2.0', ageVerified: true });
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

const ask = (sock, event, payload) => new Promise((res) => sock.emit(event, payload, res));
const vote = (sock, messageId, value) => ask(sock, 'vote-topic', { messageId, value });

function history(sock, code, opts = {}) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code, ...opts });
  return p;
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

test.after(() => { server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

test('votes on forum topics', async (t) => {
  const admin = await register('admin');
  const bob = await register('bob');
  assert.ok(admin.token && bob.token, 'accounts registered');
  const A = await connect(admin.token);
  const B = await connect(bob.token);

  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'ideas'));
  A.emit('create-channel', { name: 'ideas' });
  const code = (await list).find((c) => c.name === 'ideas').code;
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 1));
  A.emit('toggle-channel-permission', { code, permission: 'forum' });
  assert.ok(await list, 'forum mode on');
  A.emit('enter-channel', { code });
  B.emit('join-channel', { code });
  await wait(200);
  B.emit('enter-channel', { code });
  await wait(200);
  // Private from here, so carol, who signs up next, is not in the forum.
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_private));
  A.emit('toggle-channel-permission', { code, permission: 'private' });
  assert.ok(await list, 'forum made private');
  const carol = await register('carol');
  const C = await connect(carol.token);

  for (const content of ['first idea', 'second idea']) {
    A.emit('send-message', { code, content });
    await wait(150);
  }
  const h = await history(A, code);
  const first = h.messages.find((m) => m.content === 'first idea');
  const second = h.messages.find((m) => m.content === 'second idea');
  assert.ok(first && second, 'topics posted');
  assert.deepStrictEqual(first.votes, { likes: 0, dislikes: 0, mine: 0 }, 'topics start with no votes');

  await t.test('votes are refused while the forum has them off', async () => {
    const r = await vote(B, first.id, 1);
    assert.match(r.error || '', /turned off/);
  });

  await t.test('only someone who can change the channel settings turns votes on', async () => {
    const r = await ask(B, 'set-forum-votes', { code, mode: 'likes' });
    assert.ok(r.error, 'a member is refused');
    const seen = next(B, 'forum-votes-mode', (d) => d && d.code === code);
    const ok = await ask(A, 'set-forum-votes', { code, mode: 'likes' });
    assert.ok(ok.success, 'the admin turns likes on');
    assert.deepStrictEqual(await seen, { code, mode: 'likes' }, 'members in the forum hear about it');
    const chs = await new Promise((res) => { B.once('channels-list', res); B.emit('get-channels'); });
    assert.strictEqual(chs.find((c) => c.code === code).forum_votes, 1, 'the channel list carries the setting');
  });

  await t.test('like, take it back, and see the counts live', async () => {
    const live = next(A, 'topic-votes', (d) => d && d.messageId === first.id);
    const r = await vote(B, first.id, 1);
    assert.deepStrictEqual([r.likes, r.dislikes, r.mine], [1, 0, 1]);
    const got = await live;
    assert.deepStrictEqual([got.likes, got.dislikes], [1, 0], 'the admin sees the new count');
    assert.strictEqual(got.userId, undefined, 'the broadcast does not say who voted');

    const again = await vote(B, first.id, 1);
    assert.deepStrictEqual([again.likes, again.mine], [1, 1], 'voting the same way twice still counts once');
    const back = await vote(B, first.id, 0);
    assert.deepStrictEqual([back.likes, back.mine], [0, 0], 'taken back');
  });

  await t.test('dislikes need the likes and dislikes setting', async () => {
    const r = await vote(B, first.id, -1);
    assert.match(r.error || '', /Dislikes are turned off/);
    await ask(A, 'set-forum-votes', { code, mode: 'both' });
    const d = await vote(B, first.id, -1);
    assert.deepStrictEqual([d.likes, d.dislikes, d.mine], [0, 1, -1]);
    const l = await vote(B, first.id, 1);
    assert.deepStrictEqual([l.likes, l.dislikes, l.mine], [1, 0, 1], 'liking replaces the dislike');
    const d2 = await vote(B, first.id, -1);
    assert.deepStrictEqual([d2.likes, d2.dislikes, d2.mine], [0, 1, -1], 'and the other way round');
  });

  await t.test('history carries the counts and your own vote', async () => {
    await vote(A, second.id, 1);
    await vote(B, second.id, 1);
    const hb = await history(B, code);
    const s = hb.messages.find((m) => m.id === second.id);
    const f = hb.messages.find((m) => m.id === first.id);
    assert.deepStrictEqual(s.votes, { likes: 2, dislikes: 0, mine: 1 });
    assert.deepStrictEqual(f.votes, { likes: 0, dislikes: 1, mine: -1 });
  });

  await t.test('Most liked order', async () => {
    const top = await history(A, code, { sort: 'top' });
    // Pages arrive least first, like every forum page.
    assert.deepStrictEqual(top.messages.map((m) => m.content), ['first idea', 'second idea']);
    // A cursor on a topic with a score of 0 or below still pages.
    const older = await history(A, code, { sort: 'top', before: second.id });
    assert.deepStrictEqual(older.messages.map((m) => m.content), ['first idea']);
  });

  await t.test('only members who can see the forum vote', async () => {
    const r = await vote(C, first.id, 1);
    assert.match(r.error || '', /Not a member/);
  });

  await t.test('replies and chat messages cannot be voted on', async () => {
    await new Promise((res) => A.emit('send-thread-message', { parentId: first.id, content: 'a reply' }, res));
    const th = next(A, 'thread-messages', (d) => d && d.parentId === first.id);
    A.emit('get-thread-messages', { parentId: first.id });
    const thread = await th;
    const reply = thread && thread.messages.find((m) => m.content === 'a reply');
    assert.ok(reply, 'reply found');
    assert.match((await vote(B, reply.id, 1)).error || '', /not a forum topic/);
  });

  await t.test('turning votes off refuses votes and keeps the stored ones', async () => {
    await ask(A, 'set-forum-votes', { code, mode: 'off' });
    assert.match((await vote(B, second.id, 0)).error || '', /turned off/);
    await ask(A, 'set-forum-votes', { code, mode: 'likes' });
    const hb = await history(B, code);
    assert.strictEqual(hb.messages.find((m) => m.id === second.id).votes.likes, 2, 'counts come back');
  });

  await t.test('deleting a topic deletes its votes', async () => {
    const gone = next(A, 'message-deleted', (d) => d && d.messageId === second.id);
    A.emit('delete-message', { messageId: second.id });
    assert.ok(await gone, 'topic deleted');
    assert.match((await vote(B, second.id, 1)).error || '', /not a forum topic/);
  });

  for (const s of [A, B, C]) s.close();
});

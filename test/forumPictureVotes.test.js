/**
 * Likes and dislikes on each picture of a blog post (#5784): a picture is the
 * topic or one of its author's additions, votes follow the forum's setting
 * and the same access rules as topic votes, one vote per person per picture,
 * and the counts reach everyone in the forum live.
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

const PORT = 3447;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-picvotes-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const register = (username) => post('/api/auth/register', { username, password: 'picvotetest123', eulaVersion: '2.0', ageVerified: true });
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
const vote = (sock, messageId, value) => ask(sock, 'vote-piece', { messageId, value });
const reply = (sock, parentId, content, replyTo) => ask(sock, 'send-thread-message', { parentId, content, replyTo });

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

async function makeForum(A, name) {
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
  A.emit('create-channel', { name });
  const code = (await list).find((c) => c.name === name).code;
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 1));
  A.emit('toggle-channel-permission', { code, permission: 'forum' });
  assert.ok(await list, 'forum mode on');
  return code;
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
  // Wait for the server to let go of its database before removing the dir.
  if (server && server.exitCode === null) { const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone; }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (err) { console.warn('[forumPictureVotes test] could not remove the scratch data dir:', err.message); }
});

test('votes on the pictures of a blog post', async (t) => {
  const admin = await register('admin');
  const bob = await register('bob');
  assert.ok(admin.token && bob.token, 'accounts registered');
  const A = await connect(admin.token);
  const B = await connect(bob.token);

  const code = await makeForum(A, 'gallery');
  A.emit('enter-channel', { code });
  B.emit('join-channel', { code });
  await wait(200);
  B.emit('enter-channel', { code });
  await wait(200);
  // Private from here, so carol, who signs up next, is not in the forum.
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_private));
  A.emit('toggle-channel-permission', { code, permission: 'private' });
  assert.ok(await list, 'forum made private');
  const carol = await register('carol');
  const C = await connect(carol.token);

  // Bob's post: the topic and two more pictures. The admin comments.
  B.emit('send-message', { code, content: '/uploads/one.png', title: 'Sketches' });
  await wait(200);
  const topic = (await history(B, code)).messages.find((m) => m.content === '/uploads/one.png');
  assert.ok(topic, 'topic posted');
  await reply(B, topic.id, '/uploads/two.png');
  await reply(B, topic.id, '/uploads/three.png');
  await reply(A, topic.id, 'lovely', topic.id);
  const th0 = await thread(A, topic.id);
  const two = th0.messages.find((m) => m.content === '/uploads/two.png');
  const three = th0.messages.find((m) => m.content === '/uploads/three.png');
  const comment = th0.messages.find((m) => m.content === 'lovely');
  assert.ok(two && three && comment, 'replies posted');

  await t.test('only a blog forum has pictures to vote on', async () => {
    await ask(A, 'set-forum-votes', { code, mode: 'both' });
    assert.match((await vote(A, two.id, 1)).error || '', /not a picture/);
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.forum_blog === 1));
    A.emit('toggle-channel-permission', { code, permission: 'forum_blog' });
    assert.ok(await list, 'blog mode on');
  });

  await t.test('the thread carries every picture\'s counts', async () => {
    const th = await thread(A, topic.id);
    assert.deepStrictEqual(Object.keys(th.pieceVotes).map(Number).sort((x, y) => x - y), [topic.id, two.id, three.id].sort((x, y) => x - y),
      'the topic and the author\'s additions, not the comment');
    assert.deepStrictEqual(th.pieceVotes[two.id], { likes: 0, dislikes: 0, mine: 0 });
  });

  await t.test('comments and chat messages are not pictures', async () => {
    assert.match((await vote(B, comment.id, 1)).error || '', /not a picture/);
    assert.match((await vote(B, 999999, 1)).error || '', /not a picture/);
    assert.match((await vote(B, 'x', 1)).error || '', /Invalid vote/);
    assert.match((await vote(B, two.id, 2)).error || '', /Invalid vote/);
  });

  await t.test('like, again, switch, take back, with live counts', async () => {
    const live = next(B, 'topic-votes', (d) => d && d.messageId === two.id);
    const r = await vote(A, two.id, 1);
    assert.deepStrictEqual([r.likes, r.dislikes, r.mine], [1, 0, 1]);
    const got = await live;
    assert.deepStrictEqual([got.likes, got.dislikes, got.channelCode], [1, 0, code], 'bob sees the new count');
    assert.strictEqual(got.userId, undefined, 'the broadcast does not say who voted');

    const again = await vote(A, two.id, 1);
    assert.deepStrictEqual([again.likes, again.mine], [1, 1], 'one vote per person per picture');
    const b = await vote(B, two.id, 1);
    assert.strictEqual(b.likes, 2, 'each person counts once');

    const d = await vote(A, two.id, -1);
    assert.deepStrictEqual([d.likes, d.dislikes, d.mine], [1, 1, -1], 'a dislike replaces the like');
    const back = await vote(A, two.id, 0);
    assert.deepStrictEqual([back.likes, back.dislikes, back.mine], [1, 0, 0], 'taken back');

    const th = await thread(B, topic.id);
    assert.deepStrictEqual(th.pieceVotes[two.id], { likes: 1, dislikes: 0, mine: 1 }, 'bob\'s own vote comes back with the thread');
    assert.deepStrictEqual(th.pieceVotes[three.id], { likes: 0, dislikes: 0, mine: 0 }, 'other pictures keep their own counts');
  });

  await t.test('your other devices learn your vote', async () => {
    const B2 = await connect(bob.token);
    const mine = next(B2, 'topic-vote-mine', (d) => d && d.messageId === three.id);
    await vote(B, three.id, -1);
    const got = await mine;
    assert.strictEqual(got && got.value, -1);
    B2.close();
  });

  await t.test('the opening picture\'s votes are the topic\'s', async () => {
    await vote(A, topic.id, 1);
    const card = (await history(B, code)).messages.find((m) => m.id === topic.id);
    assert.strictEqual(card.votes.likes, 1, 'the topic card shows the vote');
    const th = await thread(A, topic.id);
    assert.deepStrictEqual(th.pieceVotes[topic.id], { likes: 1, dislikes: 0, mine: 1 });
  });

  await t.test('only members who can see the forum vote', async () => {
    assert.match((await vote(C, two.id, 1)).error || '', /Not a member/);
  });

  await t.test('the forum\'s setting applies', async () => {
    await ask(A, 'set-forum-votes', { code, mode: 'likes' });
    assert.match((await vote(B, two.id, -1)).error || '', /Dislikes are turned off/);
    await ask(A, 'set-forum-votes', { code, mode: 'off' });
    assert.match((await vote(B, two.id, 0)).error || '', /turned off/);
    await ask(A, 'set-forum-votes', { code, mode: 'both' });
    const th = await thread(B, topic.id);
    assert.strictEqual(th.pieceVotes[two.id].likes, 1, 'stored votes come back');
  });

  await t.test('a timed out member cannot vote', async () => {
    A.emit('mute-user', { userId: bob.user.id, duration: 5 });
    await wait(300);
    assert.match((await vote(B, two.id, 0)).error || '', /timeout/);
    A.emit('unmute-user', { userId: bob.user.id });
    await wait(300);
    assert.ok((await vote(B, two.id, 0)).success, 'votes again once the timeout ends');
  });

  await t.test('deleting a picture deletes its votes', async () => {
    const gone = next(A, 'message-deleted', (d) => d && d.messageId === three.id);
    B.emit('delete-message', { messageId: three.id });
    assert.ok(await gone, 'picture deleted');
    assert.match((await vote(A, three.id, 1)).error || '', /not a picture/);
    const th = await thread(A, topic.id);
    assert.strictEqual(th.pieceVotes[three.id], undefined);
  });

  for (const s of [A, B, C]) s.close();
});

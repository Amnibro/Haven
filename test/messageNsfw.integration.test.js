'use strict';

/**
 * Marking a message NSFW (src/messageNsfw.js): the author marks their own,
 * a moderator marks anyone's, an author cannot lift a moderator's mark, and
 * the mark travels with history and thread replies.
 *
 *   node --test test/messageNsfw.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3496;
const h = createHarness(PORT, 'message-nsfw');

test.before(() => h.start());
test.after(() => h.stop());

test('who may mark a message NSFW', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  A.emit('create-channel', { name: 'talk' });
  let ch;
  for (let i = 0; i < 30 && !ch; i++) {
    ch = db.prepare('SELECT id, code FROM channels WHERE name = ?').get('talk');
    if (!ch) await wait(100);
  }
  assert.ok(ch, 'channel created');
  for (const s of [A, B, C]) { s.emit('join-channel', { code: ch.code }); await wait(100); }
  for (const s of [A, B, C]) s.emit('enter-channel', { code: ch.code });
  await wait(200);

  const post = (userId, content, threadId = null) => Number(db.prepare('INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, ?, ?)')
    .run(ch.id, userId, content, threadId).lastInsertRowid);
  const mark = (sock, messageId, nsfw) => new Promise((res) => sock.emit('set-message-nsfw', { messageId, nsfw }, res));
  const stored = (id) => db.prepare('SELECT nsfw, nsfw_by FROM messages WHERE id = ?').get(id);

  const mine = post(bob.id, 'https://example.com/video');

  // Someone else without moderation rights cannot.
  assert.ok((await mark(C, mine, true)).error, 'carol refused');
  assert.strictEqual(stored(mine).nsfw, 0);

  // The author can, and everyone in the channel hears about it.
  const heard = new Promise((res) => C.once('message-nsfw', res));
  assert.ok((await mark(B, mine, true)).success);
  const ev = await heard;
  assert.deepStrictEqual({ id: ev.messageId, nsfw: ev.nsfw, code: ev.channelCode }, { id: mine, nsfw: true, code: ch.code });

  // History carries it, and only on the marked message.
  const plain = post(bob.id, 'plain');
  const hist = await new Promise((res) => { C.once('message-history', res); C.emit('get-messages', { code: ch.code }); });
  assert.strictEqual(hist.messages.find((m) => m.id === mine).nsfw, true);
  assert.ok(!('nsfw' in hist.messages.find((m) => m.id === plain)), 'nothing extra on ordinary messages');

  // The author lifts their own mark.
  assert.ok((await mark(B, mine, false)).success);
  assert.strictEqual(stored(mine).nsfw, 0);

  // A moderator's mark stays until a moderator lifts it.
  assert.ok((await mark(A, mine, true)).success, 'the admin marks anyone\'s');
  assert.ok((await mark(B, mine, false)).error, 'the author cannot lift it');
  assert.strictEqual(stored(mine).nsfw, 1);
  const audit = db.prepare("SELECT action FROM audit_log WHERE action = 'message_nsfw_on'").get();
  assert.ok(audit, 'the moderator\'s mark is in the audit log');
  assert.ok((await mark(A, mine, false)).success);
  assert.strictEqual(stored(mine).nsfw, 0);

  // Thread replies carry it too.
  const reply = post(bob.id, 'in a thread', plain);
  assert.ok((await mark(B, reply, true)).success);
  const th = await new Promise((res) => { C.once('thread-messages', res); C.emit('get-thread-messages', { parentId: plain }); });
  assert.strictEqual(th.messages.find((m) => m.id === reply).nsfw, true);

  A.disconnect();
  B.disconnect();
  C.disconnect();
});

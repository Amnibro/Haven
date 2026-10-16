'use strict';

/**
 * Starting a thread on someone's message tells them, like a reply would:
 * the first reply carries threadStartedFor with the author's id, later
 * replies do not (src/threadNotify.js startedFor).
 *
 *   node --test test/threadStart.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3493;
const h = createHarness(PORT, 'thread-start');

test.before(() => h.start());
test.after(() => h.stop());

test('the first reply under a message names its author', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
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
  for (const s of [A, B]) { s.emit('join-channel', { code: ch.code }); await wait(100); }
  A.emit('enter-channel', { code: ch.code });
  B.emit('enter-channel', { code: ch.code });
  await wait(200);

  const parentId = Number(db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)')
    .run(ch.id, admin.id, 'my message').lastInsertRowid);

  const nextReply = () => new Promise((res) => A.once('new-thread-message', res));
  let got = nextReply();
  B.emit('send-thread-message', { parentId, content: 'first reply' });
  const first = await got;
  assert.equal(first.threadStartedFor, admin.id);

  await wait(1200);
  got = nextReply();
  B.emit('send-thread-message', { parentId, content: 'second reply' });
  const second = await got;
  assert.equal(second.threadStartedFor, undefined, 'only the first reply starts the thread');

  // Your own first reply under your own message tells nobody.
  const own = Number(db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)')
    .run(ch.id, admin.id, 'another').lastInsertRowid);
  await wait(1200);
  got = new Promise((res) => B.once('new-thread-message', res));
  A.emit('send-thread-message', { parentId: own, content: 'note to self' });
  assert.equal((await got).threadStartedFor, undefined);

  A.disconnect();
  B.disconnect();
});

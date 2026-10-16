'use strict';

// Who hears a thread reply, and the "N new" markers on threads. The markers
// were checked in a real browser; this drives the rules themselves.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');
const threadNotify = require('../src/threadNotify');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let M;
test.before(async () => {
  M = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-thread-unread.js')).href)).default;
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, content TEXT, thread_id INTEGER);
    CREATE TABLE thread_reads (user_id INTEGER, thread_id INTEGER, last_read_reply_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, thread_id));
    CREATE TABLE forum_topic_mutes (user_id INTEGER, topic_id INTEGER, PRIMARY KEY (user_id, topic_id));
  `);
  const add = db.prepare('INSERT INTO messages (id, channel_id, user_id, content, thread_id) VALUES (?, 1, ?, ?, ?)');
  // Thread 10 started by user 1; users 2 and 3 reply; a relayed bot (no user) too.
  add.run(10, 1, 'plan', null);
  add.run(11, 2, 'a', 10);
  add.run(12, 3, 'b', 10);
  add.run(13, null, 'from discord', 10);
  add.run(14, 2, 'c', 10);
  // Thread 20 by user 4 with no replies from 1, 2 or 3.
  add.run(20, 4, 'other', null);
  add.run(21, 4, 'self', 20);
  return db;
}

test('the people taking part in a thread are its starter and everyone who replied', () => {
  const db = makeDb();
  assert.deepEqual(threadNotify.followerIds(db, 10).sort(), [1, 2, 3]);
  assert.deepEqual(threadNotify.followerIds(db, 20), [4]);
});

test('muting a forum topic takes you off its list', () => {
  const db = makeDb();
  db.prepare('INSERT INTO forum_topic_mutes (user_id, topic_id) VALUES (3, 10)').run();
  assert.deepEqual(threadNotify.followerIds(db, 10).sort(), [1, 2]);
});

test('new replies are counted from your read position, never your own', () => {
  const db = makeDb();
  db.prepare('INSERT INTO thread_reads VALUES (2, 10, 11)').run();
  const counts = threadNotify.newCounts(db, 2, [{ id: 10, userId: 1 }, { id: 20, userId: 4 }]);
  // 12 (user 3) and 13 (bot) are new; 14 is user 2's own.
  assert.equal(counts.get(10), 2);
  assert.equal(counts.has(20), false, 'a thread never opened is not counted by the server');
});

test('the starter follows their thread before opening it', () => {
  const db = makeDb();
  const counts = threadNotify.newCounts(db, 1, [{ id: 10, userId: 1 }]);
  assert.equal(counts.get(10), 4);
});

test('a thread read to the end counts as followed with nothing new', () => {
  const db = makeDb();
  db.prepare('INSERT INTO thread_reads VALUES (3, 10, 14)').run();
  assert.equal(threadNotify.newCounts(db, 3, [{ id: 10, userId: 1 }]).get(10), 0);
});

test('a reply sounds only for those taking part, or when it is about you', () => {
  const s = (o) => M._threadReplySound(o);
  assert.equal(s({}), null, 'someone else\'s thread stays quiet');
  assert.equal(s({ followed: true }), 'message');
  assert.equal(s({ open: true }), 'message', 'a thread you have open counts as taking part');
  assert.equal(s({ isMention: true }), 'mention');
  assert.equal(s({ isReplyToMe: true }), 'reply');
  assert.equal(s({ isMention: true, isReplyToMe: true, followed: true }), 'mention');
});

test('your own reply, a muted channel or muted server stays quiet', () => {
  const s = (o) => M._threadReplySound(o);
  assert.equal(s({ mine: true, followed: true }), null);
  assert.equal(s({ channelMuted: true, isMention: true }), null);
  assert.equal(s({ quiet: true, followed: true }), null);
});

test('the chip marker reads "N new" and is empty with nothing new', () => {
  const app = Object.assign(Object.create(null), M, { _escapeHtml: (x) => String(x) });
  global.t = (k, v) => `${k}:${v ? v.count : ''}`;
  try {
    assert.equal(app._threadChipNewHtml(0), '');
    assert.match(app._threadChipNewHtml(3), /thread-preview-new.*thread_runtime\.new_other:3/);
    assert.match(app._threadChipNewHtml(1), /thread_runtime\.new_one:1/);
  } finally {
    delete global.t;
  }
});

test('a count from the server replaces the one kept on the page', () => {
  const app = Object.assign(Object.create(null), M, { currentChannel: 'abcd1234' });
  app._threadUnread = new Map([[10, { code: 'abcd1234', count: 5, followed: false }]]);
  assert.equal(app._threadNewCount(10, { count: 9 }), 5, 'no server count: the page keeps its own');
  assert.equal(app._threadNewCount(10, { newCount: 2 }), 2);
  assert.equal(app._threadUnread.get(10).count, 2);
  assert.equal(app._threadNewCount(10, { newCount: 0 }), 0);
  assert.equal(app._threadUnread.has(10), false);
});

test('replies are wired through the unread module and the server names followers', () => {
  const ev = read('public/js/modules/app-socket-events.js');
  assert.match(ev, /this\._onThreadReply\?\.\(data\);/);
  assert.doesNotMatch(ev, /\[thread\]/, 'the old mention-only path is gone from the socket handler');
  const app = read('public/js/app.js');
  assert.match(app, /import ThreadUnreadMethods from '\.\/modules\/app-thread-unread\.js\?v=[0-9.]+';/);
  assert.match(app, /this\._setupThreadUnread\(\);/);
  const msgs = read('src/socketHandlers/messages.js');
  assert.match(msgs, /const followers = threadNotify\.followerIds\(db, parentId\);/);
  assert.match(msgs, /followerIds: followers,/);
  assert.match(msgs, /threadStartedFor: startedFor/);
  assert.match(read('public/js/modules/app-thread-unread.js'), /data\.threadStartedFor === this\.user\.id/);
  const server = read('server.js');
  assert.equal((server.match(/followerIds: threadNotify\.followerIds\(db, /g) || []).length, 2, 'webhook and Discord replies name followers too');
  assert.match(read('public/js/modules/app-threads.js'), /this\._clearThreadUnread\?\.\(parentId\);/);
  const en = JSON.parse(read('public/locales/en.json'));
  for (const k of ['new_one', 'new_other', 'threads_new_one', 'threads_new_other', 'sidebar_unread']) {
    assert.ok(en.thread_runtime[k], `en.json thread_runtime.${k}`);
  }
});

test('the first reply under a message reaches its author as a thread start', () => {
  const db = makeDb();
  const add = db.prepare('INSERT INTO messages (id, channel_id, user_id, content, thread_id) VALUES (?, 1, ?, ?, ?)');
  add.run(30, 5, 'my message', null);
  add.run(31, 6, 'first reply', 30);
  assert.equal(threadNotify.startedFor(db, 30, 6, threadNotify.followerIds(db, 30)), 5);
  add.run(32, 7, 'second reply', 30);
  assert.equal(threadNotify.startedFor(db, 30, 7, threadNotify.followerIds(db, 30)), null, 'only the first reply starts it');
  // Your own first reply is not news to you, and a muted topic stays quiet.
  assert.equal(threadNotify.startedFor(db, 20, 4, threadNotify.followerIds(db, 20)), null);
  add.run(40, 8, 'topic', null);
  add.run(41, 9, 'comment', 40);
  db.prepare('INSERT INTO forum_topic_mutes (user_id, topic_id) VALUES (8, 40)').run();
  assert.equal(threadNotify.startedFor(db, 40, 9, threadNotify.followerIds(db, 40)), null);
});

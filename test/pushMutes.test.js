'use strict';

// Push notifications follow your own mutes: a member muted for you sends
// you none; a muted server sends none except DMs, and with "except
// @mentions" also messages that mention you.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { quietRecipients } = require('../src/pushMutes');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, is_dm INTEGER DEFAULT 0);
    CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
  `);
  db.prepare('INSERT INTO users (id, username, display_name) VALUES (1, ?, ?), (2, ?, ?), (3, ?, ?), (4, ?, ?)')
    .run('sender', 'Sender', 'ann', 'Ann', 'bob', 'Bobby', 'cat', null);
  db.prepare('INSERT INTO channels (id, is_dm) VALUES (10, 0), (20, 1)').run();
  const pref = db.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)');
  pref.run(2, 'server_mute', 'all');
  pref.run(3, 'server_mute', 'mentions');
  pref.run(4, 'muted_users', JSON.stringify([1]));
  return db;
}

test('a muted server is quiet except for DMs; mentions get through "except @mentions"', () => {
  const db = freshDb();
  const plain = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'hello all' });
  assert.deepEqual([...plain].sort(), [2, 3, 4]);
  const mention = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: 'hey @Bobby look' });
  assert.ok(mention.has(2), 'Mute all stays quiet for a mention');
  assert.ok(!mention.has(3), 'except @mentions lets a mention through (display name)');
  const everyone = quietRecipients(db, { channelId: 10, senderUserId: 1, messageContent: '@everyone meeting' });
  assert.ok(!everyone.has(3));
  const dm = quietRecipients(db, { channelId: 20, senderUserId: 1, messageContent: 'just you' });
  assert.ok(!dm.has(2) && !dm.has(3), 'DMs come through a muted server');
});

test('a member you muted sends you no push, even in a DM or a mention', () => {
  const db = freshDb();
  assert.ok(quietRecipients(db, { channelId: 20, senderUserId: 1, messageContent: '@cat hi' }).has(4));
  assert.ok(!quietRecipients(db, { channelId: 10, senderUserId: 2, messageContent: 'hi' }).has(4), 'others still reach them');
});

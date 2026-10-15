'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const mediaProxy = require('../src/mediaProxy');

test('a media token stops working once its account is banned or deleted', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, password_version INTEGER DEFAULT 1); CREATE TABLE bans (user_id INTEGER PRIMARY KEY);');
  db.prepare('INSERT INTO users (id) VALUES (3)').run();
  const token = mediaProxy.issueToken(3, 1);
  assert.equal(mediaProxy.verifyToken(token, db), 3);
  // A password change (or "sign out other sessions") ends it.
  db.prepare('UPDATE users SET password_version = 2 WHERE id = 3').run();
  assert.equal(mediaProxy.verifyToken(token, db), null);
  db.prepare('UPDATE users SET password_version = 1 WHERE id = 3').run();
  assert.equal(mediaProxy.verifyToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), db), null);
  db.prepare('INSERT INTO bans (user_id) VALUES (3)').run();
  assert.equal(mediaProxy.verifyToken(token, db), null);
  db.prepare('DELETE FROM bans').run();
  db.prepare('DELETE FROM users').run();
  assert.equal(mediaProxy.verifyToken(token, db), null);
});

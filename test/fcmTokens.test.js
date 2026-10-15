'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { saveFcmToken } = require('../src/fcm');

test('FCM tokens are capped in length and in number per account', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE fcm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, token)
    );
  `);
  assert.equal(saveFcmToken(db, 5, 'x'.repeat(4097)), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fcm_tokens').get().n, 0);
  for (let i = 0; i < 15; i++) saveFcmToken(db, 5, `token-${i}`);
  const kept = db.prepare('SELECT token FROM fcm_tokens WHERE user_id = 5 ORDER BY id').all().map(r => r.token);
  assert.equal(kept.length, 10);
  assert.equal(kept[0], 'token-5', 'the oldest devices drop off first');
  assert.equal(kept.at(-1), 'token-14');
  // The device moves to whoever signs in on it.
  saveFcmToken(db, 6, 'token-14');
  assert.equal(db.prepare('SELECT user_id FROM fcm_tokens WHERE token = ?').all('token-14').map(r => r.user_id).join(), '6');
});

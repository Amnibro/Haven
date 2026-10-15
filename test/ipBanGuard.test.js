'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ipBanRefusal } = require('../src/ipBanGuard');

test('automatic IP bans never cover this machine, admins or staff', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE user_ips (user_id INTEGER, ip TEXT);
    INSERT INTO users (id, is_admin) VALUES (1, 1), (2, 0), (3, 0);
    INSERT INTO user_ips VALUES (1, '203.0.113.5'), (2, '198.51.100.7'), (3, '192.0.2.9');
  `);
  const levels = { 1: 100, 2: 50, 3: 1 };
  const guard = { getUserEffectiveLevel: id => levels[id] || 0, protectAdmins: true, protectLevel: 50 };
  assert.match(ipBanRefusal(db, '127.0.0.1', guard), /own machine/);
  assert.match(ipBanRefusal(db, '::1', guard), /own machine/);
  assert.match(ipBanRefusal(db, '203.0.113.5', guard), /admin/);
  assert.match(ipBanRefusal(db, '198.51.100.7', guard), /higher rank/);
  assert.equal(ipBanRefusal(db, '192.0.2.9', guard), null);
  // An admin placing a ban by hand may still ban staff, never themselves.
  const admin = { getUserEffectiveLevel: guard.getUserEffectiveLevel, actorId: 1, protectAdmins: false, protectLevel: Infinity };
  assert.equal(ipBanRefusal(db, '198.51.100.7', admin), null);
  assert.match(ipBanRefusal(db, '203.0.113.5', admin), /you use/);
});

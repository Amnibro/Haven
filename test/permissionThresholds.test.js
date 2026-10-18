'use strict';

// Level thresholds became ticks (src/permissionThresholds.js): nobody who had
// a permission through their level loses it, the setting is emptied, and a
// second start changes nothing.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { convertPermissionThresholds } = require('../src/permissionThresholds');

function makeDb(thresholds) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, level INTEGER, scope TEXT);
    CREATE TABLE role_permissions (role_id INTEGER, permission TEXT, allowed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (role_id, permission));
    CREATE TABLE user_roles (id INTEGER PRIMARY KEY, user_id INTEGER, role_id INTEGER, channel_id INTEGER, custom_level INTEGER);
    CREATE TABLE user_role_perms (id INTEGER PRIMARY KEY, user_id INTEGER, role_id INTEGER, channel_id INTEGER, permission TEXT, allowed INTEGER NOT NULL DEFAULT 1);
  `);
  db.prepare("INSERT INTO server_settings VALUES ('permission_thresholds', ?)").run(JSON.stringify(thresholds));
  const role = db.prepare('INSERT INTO roles (id, name, level, scope) VALUES (?, ?, ?, ?)');
  role.run(1, 'Server Mod', 99, 'server');
  role.run(2, 'Channel Mod', 51, 'server');
  role.run(3, 'Member', 1, 'server');
  role.run(4, 'Room Mod', 60, 'channel');
  role.run(5, 'Group', 0, 'server');
  // Someone denied it on a high role (the old rule gave it anyway).
  db.prepare("INSERT INTO role_permissions VALUES (2, 'create_channel', 0)").run();
  // Carol is a Member ranked up to 70 on her own assignment; Dan too, but an
  // exception already takes the permission from him.
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, custom_level) VALUES (10, 3, NULL, 70), (11, 3, NULL, 70), (12, 3, NULL, NULL)').run();
  db.prepare("INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed) VALUES (11, 3, NULL, 'create_channel', 0)").run();
  return db;
}

const perms = (db, roleId) => db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? AND allowed = 1 ORDER BY permission').all(roleId).map(r => r.permission);
const own = (db, userId) => db.prepare('SELECT permission, allowed FROM user_role_perms WHERE user_id = ? ORDER BY permission').all(userId);

test('roles at or above a level get the permission ticked', () => {
  const db = makeDb({ create_channel: 50, manage_channel_settings: 50 });
  convertPermissionThresholds(db);
  assert.deepEqual(perms(db, 1), ['create_channel', 'manage_channel_settings']);
  assert.deepEqual(perms(db, 2), ['create_channel', 'manage_channel_settings'], 'a stored deny the rule overrode is replaced');
  assert.deepEqual(perms(db, 3), [], 'below the level: nothing');
  assert.deepEqual(perms(db, 4), [], 'channel roles never had it');
  assert.deepEqual(perms(db, 5), [], 'level 0 groups never had it');
  assert.equal(db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get().value, '{}');
});

test('someone who had it through their own rank keeps it as an exception', () => {
  const db = makeDb({ create_channel: 50 });
  convertPermissionThresholds(db);
  assert.deepEqual(own(db, 10), [{ permission: 'create_channel', allowed: 1 }], 'carol keeps it');
  assert.deepEqual(own(db, 11), [{ permission: 'create_channel', allowed: 0 }], 'dan\'s own exception still says no');
  assert.deepEqual(own(db, 12), [], 'an ordinary member gets nothing');
});

test('nobody gains it: ranked below the role, or holding it only inside a channel', () => {
  const db = makeDb({ create_channel: 50 });
  // Erin holds Channel Mod (51) ranked down to 20; Finn holds it only inside
  // one channel; Gus holds it ranked down too but Member carries a tick of
  // its own for him, so he had it before and keeps it.
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, custom_level) VALUES (20, 2, NULL, 20), (21, 2, 7, NULL), (22, 2, NULL, 20), (22, 5, NULL, NULL)').run();
  db.prepare("INSERT INTO role_permissions VALUES (5, 'create_channel', 1)").run();
  convertPermissionThresholds(db);
  assert.deepEqual(own(db, 20), [{ permission: 'create_channel', allowed: 0 }], 'erin did not have it and still does not');
  assert.deepEqual(own(db, 21), [{ permission: 'create_channel', allowed: 0 }], 'finn did not have it and still does not');
  assert.deepEqual(own(db, 22), [], 'gus had it through a tick and keeps it');
  assert.deepEqual(own(db, 10), [{ permission: 'create_channel', allowed: 1 }], 'carol still keeps hers');
});

test('a second start changes nothing', () => {
  const db = makeDb({ create_channel: 50 });
  convertPermissionThresholds(db);
  db.prepare("DELETE FROM role_permissions WHERE role_id = 1 AND permission = 'create_channel'").run();
  assert.deepEqual(convertPermissionThresholds(db), { converted: 0 });
  assert.deepEqual(perms(db, 1), [], 'an admin\'s later untick stays');
});

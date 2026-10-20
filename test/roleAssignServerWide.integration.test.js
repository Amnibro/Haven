'use strict';

/**
 * The role assignment window offers "Server-wide" to everyone the server
 * lets assign server-wide roles: the owner and anyone holding Promote Users
 * server-wide. It used to show it to the owner only, while the Users tab
 * already let a server Mod do it.
 *
 *   node --test test/roleAssignServerWide.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3476;
const h = createHarness(PORT, 'role-assign-server-wide');

test.before(() => h.start());
test.after(() => h.stop());

test('server-wide role assignment follows Promote Users held server-wide', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('modone');
  const helper = await h.register('helper');
  const bob = await h.register('bobby');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  const modRole = roles.find((r) => r.name === 'Mod');
  const memberRole = roles.find((r) => r.name === 'Member');
  const promoted = await h.ask(A, 'assign-role', { userId: mod.id, roleId: modRole.id });
  assert.ok(promoted.success, JSON.stringify(promoted));

  // Promote Users, but only inside one channel.
  A.emit('create-channel', { name: 'lounge' });
  let lounge = null;
  for (let i = 0; i < 30 && !lounge; i++) { await wait(100); lounge = db.prepare("SELECT id FROM channels WHERE name = 'lounge'").get(); }
  const helperRole = Number(db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Helper', 30, 'channel', '#ccc')").run().lastInsertRowid);
  db.prepare("INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, 'promote_user', 1)").run(helperRole);
  db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, ?)').run(helper.id, helperRole, lounge.id);

  const M = await h.connect(mod.token);
  const H = await h.connect(helper.token);
  const ownerData = await h.ask(A, 'get-role-assignment-data', {});
  assert.strictEqual(ownerData.callerCanServerWide, true, 'the owner');
  const modData = await h.ask(M, 'get-role-assignment-data', {});
  assert.strictEqual(modData.callerCanServerWide, true, 'a server Mod, who holds Promote Users server-wide');
  const helperData = await h.ask(H, 'get-role-assignment-data', {});
  assert.ok(helperData.error || helperData.callerCanServerWide === false, 'Promote Users in one channel is not server-wide');

  // What the window now offers the Mod, the server accepts and undoes.
  const given = await h.ask(M, 'assign-role', { userId: bob.id, roleId: memberRole.id, channelId: null });
  assert.ok(given.success, given.error);
  assert.ok(db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS NULL').get(bob.id, memberRole.id));
  const taken = await h.ask(M, 'revoke-role', { userId: bob.id, roleId: memberRole.id, channelId: null });
  assert.ok(taken.success, taken.error);
});

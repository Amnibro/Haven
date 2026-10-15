'use strict';

/**
 * A role manager who is not the admin cannot make a role automatic, or link
 * a role to channels they cannot reach: either would hand the role (and its
 * channels) to every new account, around the checks on giving it out.
 *
 *   node --test test/roleAutoAssignGuard.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3426, 'role-auto');

test.before(() => h.start());
test.after(() => h.stop());

test('only the admin makes a role automatic or links it to channels out of reach', async () => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  const modRole = roles.find((r) => r.name === 'Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: modRole.id })).success);
  assert.ok((await h.ask(A, 'set-user-server-perm', { userId: mod.id, permission: 'manage_roles', allowed: true })).success);

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'staff'));
  A.emit('create-channel', { name: 'staff', isPrivate: true });
  const staff = (await made).find((c) => c.name === 'staff');

  const created = await h.ask(A, 'create-role', { name: 'Helper', level: 10, permissions: [] });
  const helperId = created.roleId;
  assert.ok(helperId, 'helper role made');
  const linked = await h.ask(A, 'update-role-channel-access', { roleId: helperId, access: [{ channelId: staff.id, grant: true }], linkEnabled: false });
  assert.ok(linked.success);
  await wait(100);

  const auto = await h.ask(M, 'update-role', { roleId: helperId, autoAssign: true });
  assert.ok(auto && /admin/.test(auto.error), 'turning on autoAssign is refused');
  const link = await h.ask(M, 'update-role', { roleId: helperId, linkChannelAccess: true });
  assert.ok(link && /not in/.test(link.error), 'linking to a channel the mod is not in is refused');
  const newAuto = await h.ask(M, 'create-role', { name: 'Everyone', level: 5, autoAssign: true });
  assert.ok(newAuto && /admin/.test(newAuto.error), 'creating an automatic role is refused');

  const after = (await h.ask(A, 'get-roles', {})).roles;
  const helper = after.find((r) => r.id === helperId);
  assert.strictEqual(helper.auto_assign, 0);
  assert.strictEqual(helper.link_channel_access, 0);
  assert.strictEqual(after.find((r) => r.name === 'Member').auto_assign, 1, 'the default role is still the automatic one');
  assert.ok(!after.some((r) => r.name === 'Everyone'));

  // The admin can still do both.
  assert.ok((await h.ask(A, 'update-role', { roleId: helperId, linkChannelAccess: true })).success);
});

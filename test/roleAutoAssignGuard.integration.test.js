'use strict';

/**
 * A role manager who is not the admin makes a role automatic, or stops it
 * being automatic, only when they could give that role out themselves, and
 * cannot link a role to channels they cannot reach: either would hand the
 * role (and its channels) to every new account, around the checks on giving
 * it out.
 *
 *   node --test test/roleAutoAssignGuard.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3426, 'role-auto');

test.before(() => h.start());
test.after(() => h.stop());

test('automatic roles and channel links stay within what the editor could give out', async () => {
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
  assert.ok(auto && /give it out/.test(auto.error), 'a role that opens a channel out of reach is refused');
  const link = await h.ask(M, 'update-role', { roleId: helperId, linkChannelAccess: true });
  assert.ok(link && /not in/.test(link.error), 'linking to a channel the mod is not in is refused');
  const tooHigh = await h.ask(A, 'create-role', { name: 'Senior', level: 80, permissions: [] });
  assert.ok(tooHigh.roleId);
  const highAuto = await h.ask(M, 'update-role', { roleId: tooHigh.roleId, autoAssign: true });
  assert.ok(highAuto && highAuto.error, 'a role above the mod cannot be made automatic');

  const after = (await h.ask(A, 'get-roles', {})).roles;
  const helper = after.find((r) => r.id === helperId);
  assert.strictEqual(helper.auto_assign, 0);
  assert.strictEqual(helper.link_channel_access, 0);
  assert.strictEqual(after.find((r) => r.name === 'Member').auto_assign, 1, 'the default role is still the automatic one');

  // Within reach, both directions work for the mod, as the rule on undoing asks.
  const plain = await h.ask(M, 'create-role', { name: 'Plain', level: 5, autoAssign: true });
  assert.ok(plain && plain.roleId, 'a plain role below the mod can be made automatic: ' + JSON.stringify(plain));
  const off = await h.ask(M, 'update-role', { roleId: plain.roleId, autoAssign: false });
  assert.ok(off && off.success, 'and the mod can turn it off again: ' + JSON.stringify(off));

  // The admin can still do both.
  assert.ok((await h.ask(A, 'update-role', { roleId: helperId, linkChannelAccess: true })).success);
});

'use strict';

/**
 * Acting on a channel by id takes being able to reach it, and a sub-channel
 * of a private channel is as private as its parent.
 *
 *   node --test test/channelReach.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3425, 'channel-reach');
let admin, mod, carol, bob, dave;
let A, M, C, B, D;

test.before(async () => {
  await h.start();
  admin = await h.register('admin');
  mod = await h.register('mod');
  carol = await h.register('carol');
  bob = await h.register('bob');
  dave = await h.register('dave');
  A = await h.connect(admin.token);
  M = await h.connect(mod.token);
  C = await h.connect(carol.token);
  B = await h.connect(bob.token);
  D = await h.connect(dave.token);
});
test.after(() => h.stop());

async function createChannel(name, isPrivate) {
  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
  A.emit('create-channel', { name, isPrivate });
  return (await made).find((c) => c.name === name);
}

test('a moderator cannot act on a private channel they are not in', async () => {
  const roles = (await h.ask(A, 'get-roles', {})).roles;
  const modRole = roles.find((r) => r.name === 'Mod');
  const chanMod = roles.find((r) => r.name === 'Channel Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: modRole.id })).success, 'mod is a Mod');

  const secret = await createChannel('secret', true);
  A.emit('invite-to-channel', { targetUserId: carol.id, channelId: secret.id });
  await wait(300);

  const removal = await h.ask(M, 'remove-from-channel', { userId: carol.id, channelId: secret.id });
  assert.deepStrictEqual(removal, { error: 'Channel not found' });
  const missing = await h.ask(M, 'remove-from-channel', { userId: carol.id, channelId: 999999 });
  assert.deepStrictEqual(missing, { error: 'Channel not found' }, 'the same answer for a channel that does not exist');
  assert.ok((await h.channels(C)).some((c) => c.id === secret.id), 'carol is still in the private channel');

  const grant = await h.ask(M, 'assign-role', { userId: carol.id, roleId: chanMod.id, channelId: secret.id });
  assert.deepStrictEqual(grant, { error: 'Channel not found' });
  const promote = await h.ask(M, 'promote-user', { userId: carol.id, roleId: chanMod.id, channelId: secret.id });
  assert.deepStrictEqual(promote, { error: 'Channel not found' });

  // In a channel the moderator is in, removal still works.
  const lobby = await createChannel('lobby', false);
  M.emit('join-channel', { code: lobby.code });
  C.emit('join-channel', { code: lobby.code });
  await wait(400);
  const ok = await h.ask(M, 'remove-from-channel', { userId: carol.id, channelId: lobby.id });
  assert.deepStrictEqual(ok, { success: true });
});

test('a plain member cannot invite outsiders into a private channel\'s sub-channel', async () => {
  const vault = await createChannel('vault', true);
  const listed = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'annex'));
  A.emit('create-sub-channel', { parentCode: vault.code, name: 'annex' });
  const annex = (await listed).find((c) => c.name === 'annex');
  assert.ok(annex && !annex.is_private, 'a public sub-channel under a private parent');

  A.emit('invite-to-channel', { targetUserId: bob.id, channelId: vault.id });
  await wait(400);
  assert.ok((await h.channels(B)).some((c) => c.id === annex.id), 'bob is in the sub-channel through the parent');

  const refused = h.next(B, 'error-msg', (m) => /creator or moderators/.test(m));
  B.emit('invite-to-channel', { targetUserId: dave.id, channelId: annex.id });
  assert.ok(await refused, 'bob is refused');
  await wait(200);
  assert.ok(!(await h.channels(D)).some((c) => c.id === annex.id), 'dave was not let in');
});

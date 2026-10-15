'use strict';

/**
 * Kicking someone takes them out of the channel's voice call too, before the
 * channel code rotates, so they neither keep hearing the call nor receive
 * the new code through the voice room.
 *
 *   node --test test/kickLeavesVoice.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3424, 'kick-voice');

test.before(() => h.start());
test.after(() => h.stop());

test('a kicked member is dropped from voice and does not get the rotated code', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);

  const created = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'ops'));
  A.emit('create-channel', { name: 'ops' });
  const ops = (await created).find((c) => c.name === 'ops');
  // A hidden code is rotated when someone is removed.
  A.emit('update-channel-code-settings', { channelId: ops.id, code_visibility: 'private' });
  await wait(200);
  A.emit('enter-channel', { code: ops.code });

  const B = await h.connect(bob.token);
  B.emit('join-channel', { code: ops.code });
  await wait(300);
  const inVoice = h.next(B, 'voice-existing-users', (d) => d && d.channelCode === ops.code);
  B.emit('voice-join', { code: ops.code });
  assert.ok(await inVoice, 'bob joined the call');

  const rotatedForBob = h.next(B, 'channel-code-rotated', () => true, 2000);
  const kickedFromVoice = h.next(B, 'voice-kicked', (d) => d && d.channelCode === ops.code);
  const rotatedForAdmin = h.next(A, 'channel-code-rotated', (d) => d && d.oldCode === ops.code);
  A.emit('kick-user', { userId: bob.id });

  assert.ok(await kickedFromVoice, 'bob is told he left the call');
  const rotation = await rotatedForAdmin;
  assert.ok(rotation && rotation.newCode, 'the code rotated for the members left');
  assert.strictEqual(await rotatedForBob, null, 'bob is not handed the new code');

  const roster = h.next(A, 'voice-users-update', (d) => d && d.channelCode === rotation.newCode);
  A.emit('request-voice-users', { code: rotation.newCode });
  const r = await roster;
  assert.ok(r, 'the roster came back');
  assert.ok(!r.users.some((u) => u.id === bob.id), 'bob is no longer in the call');

  // Signaling from bob into the call goes nowhere now.
  const offer = h.next(A, 'voice-offer', () => true, 800);
  B.emit('voice-offer', { code: rotation.newCode, targetUserId: admin.id, offer: { type: 'offer', sdp: 'x' } });
  assert.strictEqual(await offer, null);
});

'use strict';

/**
 * Reacting in a DM takes being in it. Being the admin is no key to other
 * people's conversations.
 *
 *   node --test test/dmReactionAccess.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3427, 'dm-reaction');

test.before(() => h.start());
test.after(() => h.stop());

test('the admin cannot react in a DM they are not part of', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);

  const opened = h.next(B, 'dm-opened');
  B.emit('start-dm', { targetUserId: carol.id });
  const dm = await opened;
  assert.ok(dm && dm.code, 'the DM opened');

  const arrived = h.next(C, 'new-message', (d) => d && d.channelCode === dm.code);
  B.emit('send-message', { code: dm.code, content: 'just between us' });
  const msg = (await arrived).message;
  assert.ok(msg && msg.id, 'carol got the message');

  const leaked = h.next(B, 'reactions-updated', (d) => d && d.messageId === msg.id, 1500);
  A.emit('add-reaction', { messageId: msg.id, emoji: '👍' });
  assert.strictEqual(await leaked, null, 'the admin\'s reaction did not land');

  const own = h.next(B, 'reactions-updated', (d) => d && d.messageId === msg.id);
  C.emit('add-reaction', { messageId: msg.id, emoji: '👍' });
  const r = await own;
  assert.ok(r, 'a member can still react');
  assert.deepStrictEqual(r.reactions.map((x) => x.user_id), [carol.id], 'only carol\'s reaction is there');
});

'use strict';

/**
 * Typing reaches the other side of a DM even when the typer has it open in
 * the pop-out rather than on screen, and carries their id. Typing in a
 * channel you are not looking at and not a DM member of goes nowhere.
 *
 *   node --test test/dmTyping.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3495;
const h = createHarness(PORT, 'dm-typing');

test.before(() => h.start());
test.after(() => h.stop());

test('typing in a DM from the pop-out', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);

  const dm = await new Promise((res) => { A.once('dm-opened', (d) => res(d.code)); A.emit('start-dm', { targetUserId: bob.id }); });
  // Each side joins its DM rooms with the channel list.
  for (const s of [A, B, C]) { s.emit('get-channels'); }
  await wait(500);

  // Bob has nothing on screen; the DM is only in his pop-out.
  const seen = new Promise((res) => A.once('user-typing', res));
  B.emit('typing', { code: dm });
  const ev = await seen;
  assert.strictEqual(ev.channelCode, dm);
  assert.strictEqual(ev.userId, bob.id);

  // Carol is not in the DM: her typing there reaches no one.
  let leaked = null;
  A.on('user-typing', (d) => { leaked = d; });
  C.emit('typing', { code: dm });
  await wait(400);
  assert.strictEqual(leaked, null);

  A.disconnect();
  B.disconnect();
  C.disconnect();
});

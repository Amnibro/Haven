'use strict';

/**
 * Edit Profile opens with what the server holds: the session hands a person
 * their own bio and birthday settings, so the editor does not open blank and
 * a save there does not wipe the bio.
 *
 *   node --test test/profileBioSession.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');
const { createHarness } = require('./socketServerHarness');

const h = createHarness(3501, 'profile-bio-session');
test.before(() => h.start());
test.after(() => h.stop());

test('the session carries the bio and birthday settings', async () => {
  const me = await h.register('alice');
  const first = await h.connect(me.token);
  first.emit('set-bio', { bio: 'Hello there' });
  assert.ok(await h.next(first, 'bio-updated', (d) => d.bio === 'Hello there'), 'bio saved');
  first.disconnect();

  // A fresh connection (a reload, another device) gets it back. Listen
  // before connecting: session info is sent the moment the socket joins.
  const again = io('http://localhost:3501', { auth: { token: me.token }, transports: ['websocket'], forceNew: true });
  const info = await new Promise((res) => {
    const timer = setTimeout(() => res(null), 5000);
    again.once('session-info', (d) => { clearTimeout(timer); res(d); });
  });
  assert.ok(info, 'session info arrives');
  assert.strictEqual(info.bio, 'Hello there');
  assert.strictEqual(info.birthdayHidden, false);
  assert.strictEqual(info.birthdayHideYear, true);
  again.disconnect();
});

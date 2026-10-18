'use strict';

/**
 * Creating a channel: "Add all members" works for anyone who can invite
 * people, not only the admin (a moderator's switch used to do nothing), and
 * the More options (read only, slow mode, uploads, voice, topic) are applied
 * as the channel is made.
 *
 *   node --test test/createChannelOptions.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3502, 'create-channel-options');
test.before(() => h.start());
test.after(() => h.stop());

test('a moderator who can invite adds everyone; one who cannot does not', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const helper = await h.register('helper');
  const member = await h.register('member');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const inviter = await h.ask(A, 'create-role', { name: 'Inviter', level: 40, permissions: ['create_channel', 'invite_users'] });
  const maker = await h.ask(A, 'create-role', { name: 'Maker', level: 30, permissions: ['create_channel'] });
  assert.ok(inviter.success && maker.success, JSON.stringify({ inviter, maker }));
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: inviter.roleId })).success);
  assert.ok((await h.ask(A, 'assign-role', { userId: helper.id, roleId: maker.roleId })).success);

  const M = await h.connect(mod.token);
  const H = await h.connect(helper.token);
  const members = (name) => {
    const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(name);
    return ch ? db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(ch.id).map(r => r.user_id).sort() : null;
  };
  const made = async (name) => { for (let i = 0; i < 30 && !members(name); i++) await wait(100); await wait(400); return members(name); };

  M.emit('create-channel', { name: 'rules', addAllMembers: true, readOnly: true, slowMode: 30, mediaEnabled: false, voiceEnabled: false, topic: 'Read me first' });
  const everyone = await made('rules');
  assert.ok(everyone && everyone.includes(member.id) && everyone.includes(helper.id), 'everyone is in it: ' + JSON.stringify(everyone));
  const row = db.prepare('SELECT read_only, slow_mode_interval, media_enabled, voice_enabled, topic FROM channels WHERE name = ?').get('rules');
  assert.deepStrictEqual(row, { read_only: 1, slow_mode_interval: 30, media_enabled: 0, voice_enabled: 0, topic: 'Read me first' });

  H.emit('create-channel', { name: 'helpers', addAllMembers: true });
  const justHelper = await made('helpers');
  // The admin is in every channel anyway; nobody else is added.
  assert.ok(justHelper.includes(helper.id) && !justHelper.includes(member.id) && !justHelper.includes(mod.id),
    'without invite permission the switch does nothing: ' + JSON.stringify(justHelper));

  A.disconnect(); M.disconnect(); H.disconnect();
});

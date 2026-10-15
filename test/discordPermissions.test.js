'use strict';

// Which Discord channels the Ferry bot can read. Discord lists private
// channels to a bot but keeps them closed until its role is added, so the
// import picker and the pairing form work it out from the overwrites.

const assert = require('node:assert/strict');
const test = require('node:test');
const { accessContext, channelAccess, canReadHistory, basePermissions, bits } = require('../src/discordPermissions');

const GUILD = '900000000000000001';
const BOT = '900000000000000002';
const OWNER = '900000000000000003';
const BOT_ROLE = '900000000000000010';
const MODS = '900000000000000011';
const OTHER_ROLE = '900000000000000012';

const VIEW = 1024;
const HISTORY = 65536;
const SEND = 2048;
const ADMIN = 8;

// What GET /guilds/{id} looks like: @everyone can view and read, the bot's
// managed role adds the permissions from Ferry's invite link.
function guild(overrides = {}) {
  return {
    id: GUILD,
    owner_id: OWNER,
    roles: [
      { id: GUILD, name: '@everyone', permissions: String(VIEW + HISTORY + SEND) },
      { id: BOT_ROLE, name: 'Ferry', permissions: String(536870912 + SEND + VIEW + 32768 + 16384 + HISTORY), managed: true },
      { id: MODS, name: 'Mods', permissions: '0' },
      { id: OTHER_ROLE, name: 'Members', permissions: '0' },
    ],
    ...overrides,
  };
}

const ctxFor = (roles = [BOT_ROLE], g = guild()) => accessContext({ guild: g, member: { roles }, userId: BOT });

const channel = (overwrites) => ({ id: '900000000000000100', type: 0, name: 'x', permission_overwrites: overwrites });
const everyoneDeny = { id: GUILD, type: 0, allow: '0', deny: String(VIEW) };

test('a public channel is readable', () => {
  assert.deepEqual(channelAccess(ctxFor(), channel([])), { view: true, readHistory: true });
});

test('a private channel (@everyone denied View Channel) is hidden even though the bot role can view', () => {
  const ch = channel([everyoneDeny, { id: MODS, type: 0, allow: String(VIEW), deny: '0' }]);
  assert.deepEqual(channelAccess(ctxFor(), ch), { view: false, readHistory: false });
  assert.equal(canReadHistory(ctxFor(), ch), false);
});

test('adding the bot role to the private channel opens it', () => {
  const ch = channel([everyoneDeny, { id: BOT_ROLE, type: 0, allow: String(VIEW + HISTORY), deny: '0' }]);
  assert.equal(canReadHistory(ctxFor(), ch), true);
});

test('a role allow beats another role deny on the same channel', () => {
  const ch = channel([
    everyoneDeny,
    { id: OTHER_ROLE, type: 0, allow: '0', deny: String(VIEW) },
    { id: BOT_ROLE, type: 0, allow: String(VIEW), deny: '0' },
  ]);
  assert.equal(channelAccess(ctxFor([BOT_ROLE, OTHER_ROLE]), ch).view, true);
});

test('a member overwrite for the bot applies last', () => {
  const allowBot = channel([everyoneDeny, { id: BOT, type: 1, allow: String(VIEW + HISTORY), deny: '0' }]);
  assert.equal(canReadHistory(ctxFor(), allowBot), true);
  const denyBot = channel([{ id: BOT_ROLE, type: 0, allow: String(VIEW), deny: '0' }, { id: BOT, type: 1, allow: '0', deny: String(VIEW) }]);
  assert.equal(channelAccess(ctxFor(), denyBot).view, false);
});

test('older string overwrite types are understood too', () => {
  const ch = channel([{ id: GUILD, type: 'role', allow: '0', deny: String(VIEW) }, { id: BOT, type: 'member', allow: String(VIEW), deny: '0' }]);
  assert.equal(channelAccess(ctxFor(), ch).view, true);
});

test('view without Read Message History cannot import', () => {
  const ch = channel([{ id: GUILD, type: 0, allow: '0', deny: String(HISTORY) }]);
  assert.deepEqual(channelAccess(ctxFor(), ch), { view: true, readHistory: false });
  assert.equal(canReadHistory(ctxFor(), ch), false);
});

test('Administrator ignores every overwrite', () => {
  const g = guild();
  g.roles.find(r => r.id === BOT_ROLE).permissions = String(ADMIN);
  const ch = channel([everyoneDeny, { id: BOT, type: 1, allow: '0', deny: String(VIEW + HISTORY) }]);
  assert.equal(canReadHistory(ctxFor([BOT_ROLE], g), ch), true);
});

test('the server owner can read everything', () => {
  const ctx = accessContext({ guild: guild({ owner_id: BOT }), member: { roles: [] }, userId: BOT });
  assert.equal(canReadHistory(ctx, channel([everyoneDeny])), true);
});

test('a category child is judged by its own overwrites, not the category', () => {
  // A private category whose child was un-synced and opened to everyone, and
  // a public category whose child was made private. Discord sends both
  // children with their own permission_overwrites.
  const privateCategory = { id: '900000000000000200', type: 4, permission_overwrites: [everyoneDeny] };
  const openChild = { id: '900000000000000201', type: 0, parent_id: privateCategory.id, permission_overwrites: [] };
  const closedChild = { id: '900000000000000202', type: 0, parent_id: '900000000000000300', permission_overwrites: [everyoneDeny] };
  assert.equal(channelAccess(ctxFor(), privateCategory).view, false);
  assert.equal(canReadHistory(ctxFor(), openChild), true);
  assert.equal(canReadHistory(ctxFor(), closedChild), false);
});

test('missing data gives no context, so callers show no warning', () => {
  assert.equal(accessContext({ guild: guild(), member: null, userId: BOT }), null);
  assert.equal(accessContext({ guild: { id: GUILD, roles: [] }, member: { roles: [] }, userId: BOT }), null);
  assert.equal(accessContext({ guild: guild(), member: { roles: [] }, userId: '' }), null);
});

test('malformed permission values count as nothing', () => {
  assert.equal(bits('12abc'), 0n);
  assert.equal(bits(undefined), 0n);
  assert.equal(bits(-4), 0n);
  assert.equal(bits('1024'), 1024n);
  const g = guild();
  g.roles[0].permissions = 'nope';
  assert.equal(basePermissions(ctxFor([], g)), 0n);
});

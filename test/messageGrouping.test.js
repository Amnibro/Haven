'use strict';

// One grouping rule for channels, DMs, the pop-out DM and threads: the same
// author within five minutes folds under the message before it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let groupsWithPrevious, groupInfoFromElement, stampGroupSource, GROUP_WINDOW_MS;
test.before(async () => {
  ({ groupsWithPrevious, groupInfoFromElement, stampGroupSource, GROUP_WINDOW_MS } =
    await import(pathToFileURL(path.join(__dirname, '..', 'public/js/modules/message-grouping.js')).href));
});

// Midday local time, so a few minutes either way stay on the same day.
const NOON = new Date(2026, 9, 16, 12, 0, 0).getTime();
const at = (ms) => new Date(ms).toISOString();
const msg = (over = {}) => ({ user_id: 2, username: 'bob', created_at: at(NOON), ...over });

test('the same author within five minutes groups', () => {
  assert.equal(GROUP_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(groupsWithPrevious(msg(), msg({ created_at: at(NOON + 1000) })), true);
  assert.equal(groupsWithPrevious(msg(), msg({ created_at: at(NOON + 4 * 60 * 1000 + 59000) })), true);
});

test('a different author breaks the group', () => {
  assert.equal(groupsWithPrevious(msg(), msg({ user_id: 3, username: 'carol' })), false);
});

test('five minutes or more breaks the group', () => {
  assert.equal(groupsWithPrevious(msg(), msg({ created_at: at(NOON + GROUP_WINDOW_MS) })), false);
  assert.equal(groupsWithPrevious(msg(), msg({ created_at: at(NOON + 20 * 60 * 1000) })), false);
});

test('a reply starts its own group', () => {
  assert.equal(groupsWithPrevious(msg(), msg({ created_at: at(NOON + 1000), reply_to: 7 })), false);
});

test('a new day starts its own group, even a minute later', () => {
  const late = new Date(2026, 9, 16, 23, 59, 30).getTime();
  const prev = msg({ created_at: at(late) });
  assert.equal(groupsWithPrevious(prev, msg({ created_at: at(late + 60 * 1000) })), false);
  assert.equal(groupsWithPrevious(prev, msg({ created_at: at(late + 20 * 1000) })), true);
});

test('system lines, personas, webhooks, imports and /break never fold', () => {
  const next = { created_at: at(NOON + 1000) };
  assert.equal(groupsWithPrevious(msg({ type: 'notice' }), msg(next)), false);
  assert.equal(groupsWithPrevious(msg(), msg({ ...next, persona_id: 4, persona_username: 'Wizard' })), false);
  assert.equal(groupsWithPrevious(msg({ persona_id: 4, persona_username: 'Wizard' }), msg({ ...next, persona_id: 4, persona_username: 'Wizard' })), true);
  assert.equal(groupsWithPrevious(msg(), msg({ ...next, is_webhook: 1, webhook_username: 'Hook' })), false);
  assert.equal(groupsWithPrevious(msg(), msg({ ...next, imported_from: 'discord' })), false);
  assert.equal(groupsWithPrevious(msg(), msg({ ...next, break_chain: 1 })), false);
  assert.equal(groupsWithPrevious(null, msg(next)), false);
  assert.equal(groupsWithPrevious(msg({ created_at: 'not a date' }), msg(next)), false);
});

test('a message rebuilt from its element groups like the message itself', () => {
  const el = { dataset: { userId: '2', msgId: '10', username: 'bob', time: at(NOON) } };
  stampGroupSource(el, { is_webhook: 1, webhook_username: 'Hook', imported_from: 'discord' });
  const prev = groupInfoFromElement(el);
  assert.equal(prev.user_id, 2);
  assert.equal(prev.is_webhook, 1);
  assert.equal(groupsWithPrevious(prev, msg({ created_at: at(NOON + 1000), is_webhook: 1, webhook_username: 'Hook', imported_from: 'discord' })), true);
  assert.equal(groupsWithPrevious(prev, msg({ created_at: at(NOON + 1000) })), false);
  // A divider or system line has no author or id, so nothing groups with it.
  assert.equal(groupInfoFromElement({ dataset: {} }), null);
  assert.equal(groupInfoFromElement(null), null);
});

test('channels, DMs, the pop-out DM and threads all use the shared rule', () => {
  const messages = read('public/js/modules/app-messages.js');
  assert.match(messages, /this\._groupsWithPrevious\(prevMsg, msg\)/);
  assert.equal((messages.match(/this\._groupInfoFromElement\(/g) || []).length, 2);
  assert.equal((messages.match(/this\._stampGroupSource\(el, msg\);/g) || []).length, 2);
  assert.doesNotMatch(messages, /5 \* 60 \* 1000/);
  // The pop-out DM goes by its own channel, not the one open behind it.
  assert.match(messages, /const viewCode = \(msg && msg\._isDmRender && this\._activeDMPip\) \|\| this\.currentChannel;/);
  const pip = read('public/js/modules/app-pip-panels.js');
  assert.match(pip, /const prevMsg = this\._groupInfoFromElement\(list\.lastElementChild\);/);
  const threads = read('public/js/modules/app-threads.js');
  assert.match(threads, /threadCompact = this\._groupsWithPrevious\(this\._groupInfoFromElement\(prevEl\)/);
  assert.match(threads, /this\._stampGroupSource\(el, msg\);/);
  const app = read('public/js/app.js');
  assert.match(app, /import MessageGroupingMethods from '\.\/modules\/message-grouping\.js\?v=[\d.]+';/);
  assert.match(app, /^  MessageGroupingMethods,$/m);
});

test('grouped thread replies sit as close as the channel\'s', () => {
  const css = read('public/css/style-emoji-reactions-threads.css');
  assert.match(css, /\.thread-message:has\(\+ \.thread-message\.thread-compact\) \{\s*margin-bottom: 0\.125rem;/);
  assert.match(css, /\.thread-message\.thread-compact \.thread-msg-row \{\s*padding-top: 0\.0625rem;\s*padding-bottom: 0\.0625rem;/);
  assert.match(css, /\.thread-msg-avatar\.thread-msg-compact-spacer \{\s*height: auto;/);
});

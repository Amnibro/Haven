'use strict';

// Guards two rules that are easy to undo by accident:
//  - Staff (anyone with the full All Members list, and audit log readers)
//    see invisible members as invisible, not offline. The owner relies on it
//    to see who is really connected; it was removed once without anyone
//    noticing (2026-10-11).
//  - A closed forum topic takes replies only from moderators and admins.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('staff see invisible members in All Members', () => {
  const admin = read('src/socketHandlers/admin.js');
  assert.match(admin, /const staffSeesInvisible = canSeeAll \|\| userHasPermission\(socket\.user\.id, 'view_audit_log'\);/);
  assert.match(admin, /u\.status === 'invisible' && u\.id !== socket\.user\.id && !staffSeesInvisible/);
  const client = read('public/js/modules/app-members-admin.js');
  assert.match(client, /\['away', 'dnd', 'invisible'\]\.includes\(m\.status\)/);
  assert.match(read('public/css/style-settings.css'), /\.aml-status-dot\.aml-invisible/);
});

test('a closed forum topic refuses replies from anyone but moderators and admins', () => {
  const messages = read('src/socketHandlers/messages.js');
  assert.match(messages, /if \(parent\.is_forum && parent\.closed && !socket\.user\.isAdmin &&\s*!userHasPermission\(socket\.user\.id, 'delete_message', channel\.id\)\) \{\s*return socket\.emit\('error-msg', 'This topic is closed'\);/);
});

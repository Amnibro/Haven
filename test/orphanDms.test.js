'use strict';

// Which DMs the auto-cleanup sweep removes as orphaned (#5282). A DM with
// yourself has one member by design and must never be one; it used to be
// deleted within 15 minutes of being opened.
//
//   node --test test/orphanDms.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-orphan-dms-'));
process.env.HAVEN_DATA_DIR = DATA;

const { initDatabase } = require('../src/database');
const { findOrphanDms } = require('../src/orphanDms');

const db = initDatabase();
const user = (name) => db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(name).lastInsertRowid;
const alice = user('od-alice'), bob = user('od-bob');
let n = 0;
const dm = (creator, members, extra = {}) => {
  const id = db.prepare('INSERT INTO channels (name, code, created_by, is_dm, is_self_dm, is_group) VALUES (?, ?, ?, 1, ?, ?)')
    .run('DM', `od${String(++n).padStart(6, '0')}`, creator, extra.self ? 1 : 0, extra.group ? 1 : 0).lastInsertRowid;
  for (const m of members) db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, m);
  return id;
};
const orphaned = () => new Set(findOrphanDms(db).map((r) => r.id));

test.after(() => {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('a DM with yourself is never orphaned', () => {
  const notes = dm(alice, [alice], { self: true });
  assert.equal(orphaned().has(notes), false);
});

test('a 1:1 DM someone left is orphaned, a full one is not', () => {
  const left = dm(alice, [alice]);
  const full = dm(alice, [alice, bob]);
  const set = orphaned();
  assert.equal(set.has(left), true);
  assert.equal(set.has(full), false);
});

test('a group DM is orphaned only once nobody is left', () => {
  const waiting = dm(alice, [alice], { group: true });
  const empty = dm(alice, [], { group: true });
  const set = orphaned();
  assert.equal(set.has(waiting), false);
  assert.equal(set.has(empty), true);
});

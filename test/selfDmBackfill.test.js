'use strict';

// Which DMs count as notes to self after an upgrade. 4.19.0 marked every one
// member DM whose member started it, which also caught an old 1:1 DM whose
// partner left. A DM someone else wrote in is never notes to self.
//
//   node --test test/selfDmBackfill.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-self-dm-'));

// Haven starting up on this data folder (its own process, the way a server
// restart opens the database again).
const start = () => execFileSync(process.execPath, ['-e', "require('./src/database').initDatabase().close()"], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, HAVEN_DATA_DIR: DATA },
  stdio: 'pipe',
});
start();
const DB_FILE = fs.readdirSync(DATA).find(f => f.endsWith('.db'));
let db = new Database(path.join(DATA, DB_FILE));
const reopen = () => { db.close(); start(); db = new Database(path.join(DATA, DB_FILE)); };
const user = (name) => db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(name).lastInsertRowid;
const alice = user('sd-alice'), bob = user('sd-bob'), gone = user('sd-gone');
let n = 0;
const dm = (creator, members) => {
  const id = db.prepare('INSERT INTO channels (name, code, created_by, is_dm) VALUES (?, ?, ?, 1)')
    .run('DM', `sd${String(++n).padStart(6, '0')}`, creator).lastInsertRowid;
  for (const m of members) db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, m);
  return id;
};
const say = (ch, uid) => db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'hi')").run(ch, uid);
const isSelf = (id) => db.prepare('SELECT is_self_dm FROM channels WHERE id = ?').get(id).is_self_dm;
const forget = () => db.prepare("DELETE FROM server_settings WHERE key = 'self_dm_backfill_checked'").run();

// The channels a database from each version would hold.
function scenario() {
  const notes = dm(alice, [alice]);
  say(notes, alice);
  const emptyNotes = dm(bob, [bob]);
  const partnerLeft = dm(alice, [alice]);
  say(partnerLeft, alice); say(partnerLeft, bob);
  const partnerDeleted = dm(alice, [alice]);
  say(partnerDeleted, gone);
  db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(gone);
  const full = dm(alice, [alice, bob]);
  say(full, bob);
  return { notes, emptyNotes, partnerLeft, partnerDeleted, full };
}

test.after(() => {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('upgrading from 4.18 (no is_self_dm column) only marks real notes to self', () => {
  db.exec('ALTER TABLE channels DROP COLUMN is_self_dm');
  forget();
  const c = scenario();
  reopen();
  assert.equal(isSelf(c.notes), 1);
  assert.equal(isSelf(c.emptyNotes), 1);
  assert.equal(isSelf(c.partnerLeft), 0, 'the partner wrote in it');
  assert.equal(isSelf(c.partnerDeleted), 0, 'a deleted account wrote in it');
  assert.equal(isSelf(c.full), 0);
  assert.ok(db.prepare("SELECT 1 FROM server_settings WHERE key = 'self_dm_backfill_checked'").get());
});

test('a database 4.19.0 already backfilled is corrected once', () => {
  forget();
  const c = scenario();
  // What 4.19.0 wrote: every one member DM its member started.
  db.prepare('UPDATE channels SET is_self_dm = 1 WHERE id IN (?, ?, ?, ?)').run(c.notes, c.emptyNotes, c.partnerLeft, c.partnerDeleted);
  reopen();
  assert.equal(isSelf(c.notes), 1);
  assert.equal(isSelf(c.emptyNotes), 1);
  assert.equal(isSelf(c.partnerLeft), 0);
  assert.equal(isSelf(c.partnerDeleted), 0);

  // Once only: the check does not run on every start.
  db.prepare('UPDATE channels SET is_self_dm = 1 WHERE id = ?').run(c.partnerLeft);
  reopen();
  assert.equal(isSelf(c.partnerLeft), 1);
});

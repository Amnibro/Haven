'use strict';

// Data controls, the parts that run without a server: deleting your own
// messages older than a number of days, Auto-delete my messages (and its
// gate on allow_self_purge), and what a block means for DMs, groups and
// pushes. The socket events and the export route are covered end to end in
// dataControls.integration.test.js.
//
//   node --test test/dataControls.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-data-controls-'));
process.env.HAVEN_DATA_DIR = DATA;

const { initDatabase } = require('../src/database');
const { UPLOADS_DIR, DELETED_ATTACHMENTS_DIR } = require('../src/paths');
const selfPurge = require('../src/selfPurge');
const userBlocks = require('../src/userBlocks');
const { quietRecipients } = require('../src/pushMutes');

const UPLOAD_PATH_RE = /\/uploads\/((?!(?:bot-audio|deleted-attachments|stickers)\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)/g;
const moveUploadToDeleted = (rel) => {
  fs.mkdirSync(DELETED_ATTACHMENTS_DIR, { recursive: true });
  fs.renameSync(path.join(UPLOADS_DIR, rel), path.join(DELETED_ATTACHMENTS_DIR, rel));
};

const db = initDatabase();
const user = (name) => db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', '2020-01-01 00:00:00')").run(name).lastInsertRowid;
const ann = user('dc-ann');
const ben = user('dc-ben');
const cat = user('dc-cat');
const channel = db.prepare("INSERT INTO channels (name, code, created_by) VALUES ('general', 'dc000001', ?)").run(ann).lastInsertRowid;
const dm = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('DM', 'dc000002', ?, 1)").run(ann).lastInsertRowid;
const group = db.prepare("INSERT INTO channels (name, code, created_by, is_dm, is_group) VALUES ('Group', 'dc000003', ?, 1, 1)").run(ann).lastInsertRowid;
for (const [c, u] of [[channel, ann], [channel, ben], [channel, cat], [dm, ann], [dm, ben], [group, ann], [group, ben], [group, cat]]) {
  db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(c, u);
}
const daysAgo = (n) => db.prepare("SELECT datetime('now', ?) AS t").get(`-${n} days`).t;
const add = (u, content, createdAt, { archived = 0, ch = channel } = {}) => db.prepare(
  'INSERT INTO messages (channel_id, user_id, content, created_at, is_archived) VALUES (?, ?, ?, ?, ?)'
).run(ch, u, content, createdAt, archived).lastInsertRowid;
const exists = (id) => !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
const setAllow = (v) => db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('allow_self_purge', ?)").run(v);

function recorder() {
  const emitted = [];
  return { emitted, io: { to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }) } };
}

test('olderThanDays must be a whole number of days from 1 to 3650; missing or 0 means everything', () => {
  for (const v of [undefined, null, 0]) assert.equal(selfPurge.parseOlderThanDays(v), 0);
  for (const v of [1, 30, 3650]) assert.equal(selfPurge.parseOlderThanDays(v), v);
  for (const v of [-1, 3651, 1.5, '30', NaN, true]) assert.equal(selfPurge.parseOlderThanDays(v), null);
});

test('deleting messages older than N days leaves newer ones and protected ones, and says where it cut', async () => {
  fs.writeFileSync(path.join(UPLOADS_DIR, 'dc-old.png'), 'x');
  db.prepare("INSERT INTO upload_ownership (rel_path, user_id, bytes, scope) VALUES ('dc-old.png', ?, 1, 'channel')").run(ann);
  const old = add(ann, 'old /uploads/dc-old.png', daysAgo(40));
  const oldIso = add(ann, 'imported old', daysAgo(45).replace(' ', 'T') + '.000Z');
  const oldDm = add(ann, 'old dm', daysAgo(35), { ch: dm });
  const protectedOld = add(ann, 'protected', daysAgo(50), { archived: 1 });
  const recent = add(ann, 'recent', daysAgo(2));
  const someoneElse = add(ben, 'not mine', daysAgo(40));
  db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(old, channel, ann);

  const { emitted, io } = recorder();
  const r = await selfPurge.purgeOwnMessages({ db, io, userId: ann, olderThanDays: 30, uploadPathRe: UPLOAD_PATH_RE, moveUploadToDeleted });
  assert.equal(r.deleted, 3);
  assert.equal(r.kept, 1);
  assert.equal(r.channels, 2);
  assert.match(r.before, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const cutoff = Date.parse(r.before);
  assert.ok(Math.abs(cutoff - (Date.now() - 30 * 864e5)) < 60000, 'the cutoff is 30 days ago');

  assert.ok(!exists(old) && !exists(oldIso) && !exists(oldDm), 'old messages go, ISO-stamped imports included');
  assert.ok(exists(protectedOld), 'protected messages stay');
  assert.ok(exists(recent), 'newer messages stay');
  assert.ok(exists(someoneElse), 'other people\'s messages stay');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pinned_messages WHERE message_id = ?').get(old).n, 0);
  assert.ok(fs.existsSync(path.join(DELETED_ATTACHMENTS_DIR, 'dc-old.png')), 'their file follows the message');

  const events = emitted.filter(e => e.event === 'messages-purged');
  assert.deepEqual(events.map(e => e.room).sort(), ['channel:dc000001', 'channel:dc000002']);
  for (const e of events) assert.deepEqual(e.data, { channelCode: e.room.slice(8), userId: ann, before: r.before });
});

test('deleting everything sends no before', async () => {
  const id = add(cat, 'mine', daysAgo(1));
  const { emitted, io } = recorder();
  const r = await selfPurge.purgeOwnMessages({ db, io, userId: cat, uploadPathRe: UPLOAD_PATH_RE, moveUploadToDeleted });
  assert.equal(r.deleted, 1);
  assert.equal(r.before, null);
  assert.ok(!exists(id));
  assert.deepEqual(emitted.map(e => e.data), [{ channelCode: 'dc000001', userId: cat }]);
});

test('auto-delete runs only while self-purge is allowed, keeps the setting, and audits each member once', async () => {
  db.prepare('UPDATE users SET auto_delete_days = 7 WHERE id = ?').run(ben);
  const benOld = add(ben, 'week old', daysAgo(8));
  const benOld2 = add(ben, 'week old dm', daysAgo(9), { ch: dm });
  const benNew = add(ben, 'today', daysAgo(0));
  const audits = [];
  const { emitted, io } = recorder();
  const purge = (userId, days) => selfPurge.purgeOwnMessages({ db, io, userId, olderThanDays: days, uploadPathRe: UPLOAD_PATH_RE, moveUploadToDeleted });

  setAllow('false');
  assert.equal(await selfPurge.runAutoDelete({ db, purge, logAudit: (e) => audits.push(e) }), 0);
  assert.ok(exists(benOld), 'nothing goes while the admin has self-purge off');
  assert.equal(db.prepare('SELECT auto_delete_days FROM users WHERE id = ?').get(ben).auto_delete_days, 7, 'the setting is kept');

  setAllow('true');
  const removed = await selfPurge.runAutoDelete({ db, purge, logAudit: (e) => audits.push(e) });
  assert.equal(removed, 3, 'the 40-day-old message from the first test goes too');
  assert.ok(!exists(benOld) && !exists(benOld2) && exists(benNew));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'auto_delete_messages');
  assert.equal(audits[0].target_id, ben);
  assert.deepEqual(audits[0].details, { deleted: 3, kept: 0, channels: 2, days: 7 });
  assert.ok(emitted.every(e => e.data.before && e.data.userId === ben));

  assert.equal(await selfPurge.runAutoDelete({ db, purge, logAudit: (e) => audits.push(e) }), 0);
  assert.equal(audits.length, 1, 'a run that deletes nothing writes no audit row');
  db.prepare('UPDATE users SET auto_delete_days = 0 WHERE id = ?').run(ben);
});

test('a block stops a 1:1 DM both ways, but not group DMs or channels', () => {
  assert.equal(userBlocks.dmBlocked(db, { id: dm, is_dm: 1, is_group: 0 }, ann), false);
  db.prepare('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(ann, ben);
  assert.equal(userBlocks.dmBlocked(db, { id: dm, is_dm: 1, is_group: 0 }, ann), true, 'the blocker cannot write either');
  assert.equal(userBlocks.dmBlocked(db, { id: dm, is_dm: 1, is_group: 0 }, ben), true);
  assert.equal(userBlocks.dmBlocked(db, { id: group, is_dm: 1, is_group: 1 }, ben), false);
  assert.equal(userBlocks.dmBlocked(db, { id: channel, is_dm: 0, is_group: 0 }, ben), false);
  assert.deepEqual(userBlocks.whoBlocked(db, ben, [ann, cat]), [ann], 'ann blocked ben, so ben cannot add her to a group');
  assert.deepEqual(userBlocks.whoBlocked(db, ann, [ben, cat]), [], 'ann can still add ben');
  assert.deepEqual(userBlocks.blockedIds(db, ann), [ben]);
});

test('no push for a message from someone you blocked, DMs included', () => {
  assert.ok(quietRecipients(db, { channelId: channel, senderUserId: ben, messageContent: 'hi @dc-ann' }).has(ann));
  assert.ok(quietRecipients(db, { channelId: dm, senderUserId: ben, messageContent: 'hi' }).has(ann));
  assert.ok(!quietRecipients(db, { channelId: channel, senderUserId: cat, messageContent: 'hi' }).has(ann));
  assert.ok(!quietRecipients(db, { channelId: channel, senderUserId: ann, messageContent: 'hi' }).has(ben), 'the blocked person still hears from the blocker');
});

test('a deleted account takes its blocks with it', () => {
  const temp = user('dc-temp');
  db.prepare('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?), (?, ?)').run(temp, cat, cat, temp);
  db.prepare('DELETE FROM users WHERE id = ?').run(temp);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').get(temp, temp).n, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

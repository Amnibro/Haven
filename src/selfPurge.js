'use strict';

// Deleting your own messages (#5686), and Auto-delete my messages.
//
// Both go through purgeOwnMessages, so they behave the same way: protected
// messages stay (see src/protectedMessages.js), pins are cleared, reactions,
// votes, tags and thread replies follow through the foreign keys, and the
// files of those replies and of the messages themselves go
// the way a deleted message's do (only the author's own, only when nothing
// else still uses them; see releasableUploads). Each channel that lost
// messages gets one messages-purged event rather than one per message: a
// person with years of history would otherwise send thousands of events to
// every open client.
//
// With olderThanDays, only messages written before that many days ago go.
// The cutoff is worked out by SQLite (datetime('now', '-N days')) and every
// created_at is passed through datetime() before comparing, so imported
// messages stored as ISO strings compare the same as native ones. The event
// and the result carry it as an ISO 8601 UTC string (`before`), and clients
// drop only that author's rows older than it.

const { releasableUploads, utcStamp } = require('./socketHandlers/helpers');
const protectedMessages = require('./protectedMessages');

// What the auto-delete picker offers; 0 is off.
const AUTO_DELETE_CHOICES = [0, 1, 7, 30, 90, 365];
const MAX_OLDER_THAN_DAYS = 3650;

/** A whole number of days from 1 to 3650, 0 for "everything", or null when it is neither. */
function parseOlderThanDays(raw) {
  if (raw === undefined || raw === null || raw === 0) return 0;
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_OLDER_THAN_DAYS ? raw : null;
}

function selfPurgeAllowed(db) {
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'allow_self_purge'").get();
  return !!row && row.value === 'true';
}

/**
 * Delete one member's own messages, or only those older than `olderThanDays`.
 * Returns { deleted, kept, channels, before } where `kept` counts protected
 * messages in the same range and `before` is the cutoff (null for all).
 */
async function purgeOwnMessages({ db, io, userId, olderThanDays = 0, uploadPathRe, moveUploadToDeleted }) {
  const days = parseOlderThanDays(olderThanDays) || 0;
  const cutoff = days ? db.prepare('SELECT datetime(\'now\', ?) AS c').get(`-${days} days`).c : null;
  const before = cutoff ? utcStamp(cutoff) : null;
  const range = cutoff ? 'AND datetime(m.created_at) < @cutoff' : '';
  const params = { uid: userId, cutoff };
  const rows = db.prepare(`
    SELECT m.id, m.content, c.code
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.user_id = @uid AND ${protectedMessages.deletableSql('m')} ${range}
  `).all(params);
  const kept = db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.user_id = @uid AND ${protectedMessages.keptSql('m')} ${range}`).get(params).n;
  if (!rows.length) return { deleted: 0, kept, channels: 0, before };

  // Thread replies under these messages go with them through the foreign
  // keys; other members' files in those replies go the same way as theirs
  // would (#5783), so read the replies before the delete.
  const replyQ = db.prepare('SELECT user_id, content FROM messages WHERE thread_id = ?');
  const othersReplies = [];
  for (const r of rows) for (const reply of replyQ.all(r.id)) if (reply.user_id !== userId) othersReplies.push(reply);

  const delPin = db.prepare('DELETE FROM pinned_messages WHERE message_id = ?');
  const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) { delPin.run(r.id); delMsg.run(r.id); }
  })();

  for (const reply of othersReplies) {
    if (!Number.isInteger(reply.user_id)) continue;
    const rels = [];
    uploadPathRe.lastIndex = 0;
    let m;
    while ((m = uploadPathRe.exec(reply.content || '')) !== null) rels.push(m[1]);
    for (const rel of releasableUploads(db, rels, [reply.user_id])) await moveUploadToDeleted(rel);
  }

  const toRelease = [];
  for (const r of rows) {
    uploadPathRe.lastIndex = 0;
    let m;
    while ((m = uploadPathRe.exec(r.content || '')) !== null) toRelease.push(m[1]);
  }
  for (const rel of releasableUploads(db, toRelease, [userId])) await moveUploadToDeleted(rel);

  const codes = new Set(rows.map(r => r.code));
  if (io) {
    for (const code of codes) {
      io.to(`channel:${code}`).emit('messages-purged', before
        ? { channelCode: code, userId, before }
        : { channelCode: code, userId });
    }
  }
  return { deleted: rows.length, kept, channels: codes.size, before };
}

/**
 * Auto-delete my messages: for every member who turned it on (or just
 * `onlyUserId`), delete their messages older than their setting. Nothing runs
 * while the server does not allow self-purge. Each member whose run deleted
 * anything gets one audit-log row. `purge(userId, days)` is purgeOwnMessages
 * bound to the caller's io and upload helpers. Returns how many messages went
 * in total.
 */
async function runAutoDelete({ db, purge, logAudit, onlyUserId = null }) {
  if (!selfPurgeAllowed(db)) return 0;
  const users = db.prepare(`
    SELECT id, COALESCE(display_name, username) AS name, auto_delete_days AS days
    FROM users
    WHERE auto_delete_days > 0 AND COALESCE(is_guest, 0) = 0 ${onlyUserId ? 'AND id = ?' : ''}
  `).all(...(onlyUserId ? [onlyUserId] : []));
  let total = 0;
  for (const u of users) {
    if (!AUTO_DELETE_CHOICES.includes(u.days)) continue;
    try {
      const r = await purge(u.id, u.days);
      if (!r.deleted) continue;
      total += r.deleted;
      if (typeof logAudit === 'function') {
        logAudit({ actor: null, action: 'auto_delete_messages',
          target_type: 'user', target_id: u.id, target_name: u.name,
          details: { deleted: r.deleted, kept: r.kept, channels: r.channels, days: u.days } });
      }
    } catch (err) {
      console.error('Auto-delete failed for one member:', err.message);
    }
  }
  return total;
}

module.exports = { AUTO_DELETE_CHOICES, MAX_OLDER_THAN_DAYS, parseOlderThanDays, selfPurgeAllowed, purgeOwnMessages, runAutoDelete };

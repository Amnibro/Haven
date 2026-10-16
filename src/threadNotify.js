'use strict';

// Who hears a thread reply, and how many replies in a thread are new to you.
//
// A reply in a busy channel used to reach everyone in it with nothing to say
// where it went. A thread now belongs to the people taking part in it: the
// one who wrote the message it hangs from and everyone who has replied. Their
// ids travel with each reply (followerIds) so a client knows whether to make
// a sound without asking. Muting a forum topic takes you off its list.
//
// "New" goes by the read position kept per thread (thread_reads, #5641):
// every reply after the last one you saw that someone else wrote. It is
// counted only for threads you follow, the ones you started, opened or
// replied in; a thread you never looked at has no position to count from.

function followerIds(db, parentId) {
  const rows = db.prepare(`
    SELECT user_id FROM messages WHERE id = @p AND user_id IS NOT NULL
    UNION
    SELECT user_id FROM messages WHERE thread_id = @p AND user_id IS NOT NULL
  `).all({ p: parentId });
  const muted = new Set(db.prepare('SELECT user_id FROM forum_topic_mutes WHERE topic_id = ?')
    .all(parentId).map(r => r.user_id));
  return rows.map(r => r.user_id).filter(id => !muted.has(id));
}

// For each of the given threads you follow, how many replies you have not
// seen; threads you do not follow are left out, so the client keeps its own
// count for those. `threads` is [{ id, userId }] with userId the author of
// the message the thread hangs from.
function newCounts(db, userId, threads) {
  const out = new Map();
  if (!userId || !Array.isArray(threads) || threads.length === 0) return out;
  const ids = threads.map(t => t.id);
  const ph = ids.map(() => '?').join(',');
  const seen = new Map(db.prepare(`SELECT thread_id, last_read_reply_id FROM thread_reads WHERE user_id = ? AND thread_id IN (${ph})`)
    .all(userId, ...ids).map(r => [r.thread_id, r.last_read_reply_id]));
  const followed = threads.filter(t => seen.has(t.id) || t.userId === userId).map(t => t.id);
  if (followed.length === 0) return out;
  for (const id of followed) out.set(id, 0);
  const fph = followed.map(() => '?').join(',');
  db.prepare(`
    SELECT m.thread_id AS id, COUNT(*) AS n
    FROM messages m
    LEFT JOIN thread_reads tr ON tr.thread_id = m.thread_id AND tr.user_id = ?
    WHERE m.thread_id IN (${fph})
      AND (m.user_id IS NULL OR m.user_id != ?)
      AND m.id > COALESCE(tr.last_read_reply_id, 0)
    GROUP BY m.thread_id
  `).all(userId, ...followed, userId).forEach(r => out.set(r.id, r.n));
  return out;
}

// The first reply under a message starts its thread, and that reaches the
// message's author like a reply to them (bell, sound, push). Returns their id,
// or null when this is not the first reply, they wrote it themselves, or they
// muted the topic. Call it after the reply is stored.
function startedFor(db, parentId, replierId, followers) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(parentId).n;
  if (n !== 1) return null;
  const parent = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(parentId);
  if (!parent || parent.user_id == null || parent.user_id === replierId) return null;
  return followers.includes(parent.user_id) ? parent.user_id : null;
}

module.exports = { followerIds, newCounts, startedFor };

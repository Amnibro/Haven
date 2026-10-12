'use strict';

// A forum's unread dot in the sidebar. Replies to topics never count as new
// messages in the channel (they live in the topic's own thread), so a forum
// needs its own count: the topics this person has not caught up on, leaving
// out the topics they muted.
//
// "Not caught up" is the same rule the topic cards use (messages.js): a topic
// never opened is unread unless it is your own with no replies yet, and an
// opened one is unread when a reply landed after the last one you saw.

const CAP = 100;

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_topic_mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, topic_id)
    );
  `);
}

function count(db, userId, channelId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM messages m
      LEFT JOIN thread_reads tr ON tr.thread_id = m.id AND tr.user_id = @u
      WHERE m.channel_id = @c AND m.thread_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM forum_topic_mutes f WHERE f.user_id = @u AND f.topic_id = m.id)
        AND (CASE WHEN tr.thread_id IS NULL
               THEN (COALESCE(m.user_id, 0) != @u OR EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.id))
               ELSE COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = m.id), 0) > tr.last_read_reply_id
             END)
      LIMIT ${CAP}
    )
  `).get({ u: userId, c: channelId });
  return row ? row.n : 0;
}

function mutedIn(db, userId, topicIds) {
  if (!topicIds || !topicIds.length) return new Set();
  const ph = topicIds.map(() => '?').join(',');
  return new Set(db.prepare(`SELECT topic_id FROM forum_topic_mutes WHERE user_id = ? AND topic_id IN (${ph})`)
    .all(userId, ...topicIds).map(r => r.topic_id));
}

function setMute(db, userId, topicId, muted) {
  if (muted) db.prepare('INSERT OR IGNORE INTO forum_topic_mutes (user_id, topic_id) VALUES (?, ?)').run(userId, topicId);
  else db.prepare('DELETE FROM forum_topic_mutes WHERE user_id = ? AND topic_id = ?').run(userId, topicId);
}

module.exports = { ensureTable, count, mutedIn, setMute };

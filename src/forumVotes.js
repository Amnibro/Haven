'use strict';

/**
 * Votes on forum topics (#5742), kept out of database.js, which is already
 * past its size budget.
 *
 * channels.forum_votes is the per-forum switch: 0 off (the default),
 * 1 likes, 2 likes and dislikes. forum_votes holds one row per person per
 * topic, value 1 for a like and -1 for a dislike; taking a vote back deletes
 * the row. Rows go with their topic or their voter through the cascades.
 * Turning votes off hides them without deleting any, so turning them back
 * on brings the counts back.
 */

const MODES = { off: 0, likes: 1, both: 2 };
const MODE_NAMES = ['off', 'likes', 'both'];

function migrateForumVotes(db, addColumn) {
  addColumn('channels', 'forum_votes', 'INTEGER DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_votes (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value      INTEGER NOT NULL CHECK (value IN (1, -1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forum_votes_user ON forum_votes(user_id);
  `);
}

// { likes, dislikes } for one topic.
function totalsOf(db, messageId) {
  const r = db.prepare(`SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes
    FROM forum_votes WHERE message_id = ?`).get(messageId);
  return { likes: r.likes, dislikes: r.dislikes };
}

// Map of message id to { likes, dislikes, mine } for a page of topics, where
// mine is this reader's own vote (1, -1 or 0).
function votesFor(db, userId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT message_id, SUM(value = 1) AS likes, SUM(value = -1) AS dislikes
    FROM forum_votes WHERE message_id IN (${ph}) GROUP BY message_id`).all(...ids)) {
    out.set(r.message_id, { likes: r.likes, dislikes: r.dislikes, mine: 0 });
  }
  for (const r of db.prepare(`SELECT message_id, value FROM forum_votes WHERE user_id = ? AND message_id IN (${ph})`).all(userId, ...ids)) {
    const v = out.get(r.message_id);
    if (v) v.mine = r.value;
  }
  return out;
}

// Set one person's vote: 1, -1, or 0 to take it back.
function setVote(db, messageId, userId, value) {
  if (value === 0) {
    db.prepare('DELETE FROM forum_votes WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  } else {
    db.prepare(`INSERT INTO forum_votes (message_id, user_id, value) VALUES (?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET value = excluded.value, created_at = CURRENT_TIMESTAMP`).run(messageId, userId, value);
  }
  return totalsOf(db, messageId);
}

module.exports = { MODES, MODE_NAMES, migrateForumVotes, totalsOf, votesFor, setVote };

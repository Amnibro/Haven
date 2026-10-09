'use strict';

/**
 * Blog mode for forum channels (#5742), kept out of database.js and
 * socketHandlers/messages.js, which are already past their size budget.
 *
 * channels.forum_blog is the per-forum switch (0 off, the default; 1 on).
 * With it on, a topic belongs to its author: the author's own follow-ups in
 * the topic's thread are shown as part of the post, and everyone else's
 * replies are its comments.
 *
 * Nothing is stored per message, so turning the switch on or off needs no
 * migration and changes nothing on disk. A thread reply counts as part of
 * the post when all of these hold:
 *   - the topic has a real author (not a bot or relayed post),
 *   - the reply was written by that same account (messages.user_id, which
 *     the server sets from the signed-in socket, so nobody can claim it),
 *   - the reply is not a bot or relayed message.
 * Everything else in the thread is a comment. Only who wrote a reply
 * counts, never what it replies to, so a reply never moves between the post
 * and the comments (deleting a comment clears reply_to on its answers).
 * The server works this out and hands the client the answer; the client
 * never decides it.
 */

function migrateForumBlog(addColumn) {
  addColumn('channels', 'forum_blog', 'INTEGER DEFAULT 0');
}

// t is the reply, p the topic. True for a part of the post, and never NULL
// (IS rather than =), so NOT of it is exactly the comments.
const PART_SQL = '(p.user_id IS NOT NULL AND t.user_id IS p.user_id AND COALESCE(t.is_webhook, 0) = 0)';

// Is blog mode on for the forum this channel id names?
function blogOn(db, channelId) {
  const row = db.prepare('SELECT is_forum, is_dm, forum_blog FROM channels WHERE id = ?').get(channelId);
  return !!(row && row.is_forum && !row.is_dm && Number(row.forum_blog) === 1);
}

// The ids in one topic's thread that are part of the post.
function partIdsOf(db, parentId) {
  return new Set(db.prepare(`SELECT t.id FROM messages t JOIN messages p ON p.id = t.thread_id
    WHERE t.thread_id = ? AND ${PART_SQL}`).all(parentId).map(r => r.id));
}

function isPart(db, messageId) {
  return !!db.prepare(`SELECT 1 FROM messages t JOIN messages p ON p.id = t.thread_id
    WHERE t.id = ? AND ${PART_SQL}`).get(messageId);
}

// Map of topic id to its number of comments, for a page of topics.
function commentCounts(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT t.thread_id, COUNT(*) AS n FROM messages t JOIN messages p ON p.id = t.thread_id
    WHERE t.thread_id IN (${ph}) AND NOT ${PART_SQL} GROUP BY t.thread_id`).all(...ids)) {
    out.set(r.thread_id, r.n);
  }
  return out;
}

// Extra fields for a 'thread-updated' broadcast: the comment count when the
// topic's forum is in blog mode, nothing otherwise.
function threadExtras(db, channelId, parentId) {
  if (!blogOn(db, channelId)) return {};
  return { comments: commentCounts(db, [parentId]).get(parentId) || 0 };
}

module.exports = { migrateForumBlog, blogOn, partIdsOf, isPart, commentCounts, threadExtras };

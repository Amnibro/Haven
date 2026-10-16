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
 * Turning the switch on or off needs no migration and changes nothing on
 * disk. A thread reply counts as part of the post when all of these hold:
 *   - the topic has a real author (not a bot or relayed post),
 *   - the reply was written by that same account (messages.user_id, which
 *     the server sets from the signed-in socket, so nobody can claim it),
 *   - the reply is not a bot or relayed message,
 *   - the author did not write it as a comment (messages.blog_comment).
 * Everything else in the thread is a comment. The author writes a comment
 * by answering a comment, or by writing in a piece's open comments; that is
 * decided once, when the reply is sent, and stored, so a reply never moves
 * between the post and the comments later (deleting a comment clears
 * reply_to on its answers). The server works this out and hands the client
 * the answer; the client never decides it.
 */

function migrateForumBlog(addColumn) {
  addColumn('channels', 'forum_blog', 'INTEGER DEFAULT 0');
  // Comments on pictures only (#5765): no general Comments section, so a
  // comment has to be on one piece of the post.
  addColumn('channels', 'forum_blog_pics_only', 'INTEGER DEFAULT 0');
  // The topic's author answering a comment: a comment, not more of the post.
  addColumn('messages', 'blog_comment', 'INTEGER DEFAULT 0');
}

// t is the reply, p the topic. True for a part of the post, and never NULL
// (IS rather than =), so NOT of it is exactly the comments.
const PART_SQL = '(p.user_id IS NOT NULL AND t.user_id IS p.user_id AND COALESCE(t.is_webhook, 0) = 0 AND COALESCE(t.blog_comment, 0) = 0)';

// Is blog mode on for the forum this channel id names?
function blogOn(db, channelId) {
  const row = db.prepare('SELECT is_forum, is_dm, forum_blog FROM channels WHERE id = ?').get(channelId);
  return !!(row && row.is_forum && !row.is_dm && Number(row.forum_blog) === 1);
}

// Is "comments on pictures only" on for this blog forum?
function picsOnly(db, channelId) {
  if (!blogOn(db, channelId)) return false;
  const row = db.prepare('SELECT forum_blog_pics_only FROM channels WHERE id = ?').get(channelId);
  return !!(row && Number(row.forum_blog_pics_only) === 1);
}

// With comments on pictures only, a reply from anyone but the author has to
// answer a piece of the post (the opening post or one of the author's
// additions), or a comment that is itself on a piece. The author's own
// replies are more of the post and always go through.
function commentAllowed(db, { channelId, parentId, userId, replyTo }) {
  if (!picsOnly(db, channelId)) return true;
  const parent = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(parentId);
  if (parent && parent.user_id != null && parent.user_id === userId) return true;
  if (!replyTo) return false;
  if (replyTo === parentId) return true;
  const target = db.prepare('SELECT thread_id, reply_to FROM messages WHERE id = ?').get(replyTo);
  if (!target || target.thread_id !== parentId) return false;
  if (isPart(db, replyTo)) return true;
  const onPiece = target.reply_to === parentId || (target.reply_to && isPart(db, target.reply_to));
  return !!onPiece;
}

// Whether a reply the topic's author is sending is a comment (1) rather than
// more of the post (0). An answer to anything in the thread is a comment.
// An answer to the topic itself is a comment only when the author wrote it
// in the topic's open comments (asComment): some clients point every reply
// at the topic, and those are additions to the post. Worked out with blog
// mode off too, so turning it on later sorts earlier answers the same way.
function authorComment(db, { parentId, userId, replyTo, asComment }) {
  if (!replyTo) return 0;
  const parent = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(parentId);
  if (!parent || parent.user_id == null || parent.user_id !== userId) return 0;
  if (replyTo === parentId) return asComment === true ? 1 : 0;
  const target = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(replyTo);
  return target && target.thread_id === parentId ? 1 : 0;
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

// A piece of a blog post, for picture votes (#5784): the topic itself, or
// one of its author's additions in the topic's thread, in a forum with blog
// mode on. Returns what the vote checks need (the channel and its settings,
// and the topic the piece belongs to), or null for any other message.
function pieceOf(db, messageId) {
  const m = db.prepare(`SELECT m.id, m.thread_id, c.id AS channel_id, c.code, c.is_forum, c.is_dm, c.forum_blog, c.forum_votes, c.role_gate
    FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?`).get(messageId);
  if (!m || !m.is_forum || m.is_dm || Number(m.forum_blog) !== 1) return null;
  if (m.thread_id) {
    const topic = db.prepare('SELECT thread_id, channel_id FROM messages WHERE id = ?').get(m.thread_id);
    if (!topic || topic.thread_id || topic.channel_id !== m.channel_id) return null;
    if (!isPart(db, m.id)) return null;
  }
  return { ...m, topicId: m.thread_id || m.id };
}

module.exports = { migrateForumBlog, blogOn, picsOnly, commentAllowed, authorComment, partIdsOf, isPart, commentCounts, threadExtras, pieceOf };

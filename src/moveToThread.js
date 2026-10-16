'use strict';

// "Move here as thread": selected messages go into the thread under another
// message in the same channel. The socket side (permission, broadcasts,
// audit) is socketHandlers/moveToThread.js; this file holds the rules and
// the database change, kept out of socketHandlers/messages.js, which is past
// its size budget.
//
// The rules:
//  - the base and every selected message are top-level messages of one
//    channel; cross-channel moves are left to Move to...
//  - the base is not one of the selected messages and not itself a reply in
//    a thread, since threads do not nest. A reply id is refused rather than
//    swapped for its root: the channel feed only shows roots, so a reply id
//    means a stale or hand-made request, and quietly picking a different
//    message than the one named would be the surprise
//  - a selected message with a thread of its own brings its replies along,
//    flattened into the target thread. Refusing would make a big selection
//    fail over one message, and leaving them behind would strand them under a
//    message that is now a reply. A reply that answered nothing in particular
//    now points at the message it was under, so it still reads as an answer
//  - nothing about a message changes but where it hangs: author, times,
//    reactions, attachments, pins and protection all stay. A thread lists by
//    time, so everything lands in its original order
//  - not in DMs (no threads there, and Move is off in DMs) and not in a blog
//    forum, where who wrote a reply decides whether it is part of the post or
//    a comment, so moving messages in would rewrite someone's post
//  - a forum topic paired with a Discord post through Ferry stays a topic,
//    or replies from Discord would land under a message that is a reply

const forumBlog = require('./forumBlog');

const MAX_SELECTED = 200;

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

// Why this move cannot happen, or null. `channel` is the channels row.
function refusal(db, { channel, rootId, ids }) {
  if (!channel) return 'Channel not found';
  if (channel.is_dm) return 'Threads are not available in DMs';
  if (forumBlog.blogOn(db, channel.id)) return 'Messages cannot be moved into a blog post';
  if (ids.length === 0 || ids.length > MAX_SELECTED) return `Select between 1 and ${MAX_SELECTED} messages`;
  if (ids.includes(rootId)) return 'Pick a message that is not one of the selected ones';

  const root = db.prepare('SELECT id, channel_id, thread_id FROM messages WHERE id = ?').get(rootId);
  if (!root || root.channel_id !== channel.id) return 'That message is not in this channel';
  if (root.thread_id) return 'That message is a reply in a thread, and threads cannot hold threads';

  const ph = placeholders(ids.length);
  const rows = db.prepare(`SELECT id, thread_id FROM messages WHERE id IN (${ph}) AND channel_id = ?`).all(...ids, channel.id);
  if (rows.length !== ids.length) return 'Some messages were not found in this channel';
  if (rows.some(r => r.thread_id)) return 'Some selected messages are already replies in a thread';

  if (channel.is_forum) {
    const paired = db.prepare(`SELECT 1 FROM ferry_forum_threads WHERE topic_message_id IN (${ph}) LIMIT 1`).get(...ids);
    if (paired) return 'A topic linked to a Discord post cannot be moved into another topic';
  }
  return null;
}

// Read positions (thread_reads, threadNotify.js) count replies above the last
// one you saw as new. Moved messages are old news that was already on screen
// in the channel, so anyone who was caught up on the thread stays caught up,
// the author of the base included. Someone with replies still to read keeps
// their place, so nothing they had not seen is marked read for them.
// Worked out before the move, so only the thread's own replies are looked at.
function caughtUpReaders(db, rootId, rootUserId) {
  const people = new Map(db.prepare('SELECT user_id, last_read_reply_id FROM thread_reads WHERE thread_id = ?')
    .all(rootId).map(r => [r.user_id, r.last_read_reply_id]));
  if (rootUserId != null && !people.has(rootUserId)) people.set(rootUserId, 0);
  const unseen = db.prepare(`SELECT 1 FROM messages WHERE thread_id = ? AND id > ?
    AND (user_id IS NULL OR user_id != ?) LIMIT 1`);
  return [...people].filter(([userId, lastRead]) => !unseen.get(rootId, lastRead, userId)).map(([userId]) => userId);
}

function markCaughtUp(db, rootId, userIds) {
  const upsert = db.prepare(`INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id)
    VALUES (?, ?, COALESCE((SELECT MAX(id) FROM messages WHERE thread_id = ?), 0))
    ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_reply_id = MAX(last_read_reply_id, excluded.last_read_reply_id)`);
  for (const userId of userIds) upsert.run(userId, rootId, rootId);
}

// Makes the move. Returns { error } or what moved:
//   selected      the selected ids, which leave the channel feed
//   moved         every id now in the thread because of this move
//   absorbedRoots selected messages whose own replies came along
function moveIntoThread(db, { channel, rootId, messageIds }) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter(id => Number.isInteger(id) && id > 0))];
  if (!Number.isInteger(rootId) || rootId <= 0) return { error: 'Invalid message' };
  const why = refusal(db, { channel, rootId, ids });
  if (why) return { error: why };

  const ph = placeholders(ids.length);
  const run = db.transaction(() => {
    const root = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(rootId);
    const caughtUp = caughtUpReaders(db, rootId, root ? root.user_id : null);
    const replies = db.prepare(`SELECT id, thread_id FROM messages WHERE thread_id IN (${ph})`).all(...ids);
    const absorbedRoots = [...new Set(replies.map(r => r.thread_id))];

    db.prepare(`UPDATE messages SET reply_to = thread_id WHERE thread_id IN (${ph}) AND reply_to IS NULL`).run(...ids);
    db.prepare(`UPDATE messages SET thread_id = ? WHERE thread_id IN (${ph})`).run(rootId, ...ids);
    db.prepare(`UPDATE messages SET thread_id = ? WHERE id IN (${ph})`).run(rootId, ...ids);
    // They are no longer threads or topics: nothing left to have read or muted.
    db.prepare(`DELETE FROM thread_reads WHERE thread_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM forum_topic_mutes WHERE topic_id IN (${ph})`).run(...ids);

    const moved = [...ids, ...replies.map(r => r.id)].sort((a, b) => a - b);
    markCaughtUp(db, rootId, caughtUp);
    return { selected: [...ids].sort((a, b) => a - b), moved, absorbedRoots };
  });
  return run();
}

module.exports = { MAX_SELECTED, refusal, moveIntoThread };

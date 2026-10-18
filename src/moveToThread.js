'use strict';

// "Move here as thread": selected messages go into the thread under another
// message, in the same channel or another one. The socket side (permission,
// broadcasts, audit) is socketHandlers/moveToThread.js; this file holds the
// rules and the database change, kept out of socketHandlers/messages.js,
// which is past its size budget.
//
// The rules:
//  - the selection comes from one channel and the base (the message they go
//    under) can be in that channel or another; the socket handler checks the
//    mover may move messages in both, as Move to... does
//  - the base is a top-level message: not one of the selected messages and
//    not itself a reply in a thread, since threads do not nest. A reply id is
//    refused rather than swapped for its root: the channel feed only shows
//    roots, so a reply id means a stale or hand-made request, and quietly
//    picking a different message than the one named would be the surprise
//  - a selected message with a thread of its own brings its replies along,
//    flattened into the target thread. Refusing would make a big selection
//    fail over one message, and leaving them behind would strand them under a
//    message that is now a reply. A reply that answered nothing in particular
//    now points at the message it was under, so it still reads as an answer
//  - the base's own replies stay and the newcomers join them. A thread lists
//    by original time, so everything interleaves in the order it was written
//  - a selected reply whose root is selected too is moved once, with its
//    root; one already under the base is left as it is. Any other selected
//    reply means the selection is out of date (someone else moved it), so
//    the move is refused and nothing changes
//  - nothing about a message changes but where it hangs: author, times,
//    reactions, attachments, pins, protection and self-destruct timers stay
//  - across channels, a reply banner that points at a message left behind is
//    dropped, so the other channel's readers do not see a line of a message
//    from a channel they may not be able to open
//  - not in DMs (no threads there, and Move is off in DMs) and not to or from
//    a blog forum, where who wrote a reply decides whether it is part of the
//    post or a comment, so moving messages would rewrite someone's post. The
//    one exception: inside one blog forum, an author's own posts can be
//    combined into another of their posts. Each becomes a piece of it, with
//    its likes; comments on them become comments on it
//  - polls, role menus and messages sent as a persona stay where they are:
//    a thread shows a reply as plain text under its account, so a poll could
//    not be voted on, a menu would not work and a persona would lose its name
//  - a forum topic paired with a Discord post through Ferry stays a topic,
//    or replies from Discord would land under a message that is a reply
//
// Everything runs in one transaction, checked again inside it, so two moves
// at once or a base deleted in the meantime leave nothing half done.

const forumBlog = require('./forumBlog');

const MAX_SELECTED = 200;

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

// Read positions (thread_reads, threadNotify.js) count replies above the last
// one you saw as new. Moved messages are old news that was already on screen,
// so anyone who was caught up on the thread stays caught up, the author of
// the base included. Someone with replies still to read keeps their place, so
// nothing they had not seen is marked read for them. Worked out before the
// move, so only the thread's own replies are looked at.
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

// Before a move into channel `channelId`: a reply banner on a moving message
// (one of `tops` or a reply in their threads) that points at a message which
// stays in another channel goes, so readers there do not see a line of a
// message from a channel they may not be able to open. Banners between
// messages that move together stay.
function dropStrayBanners(db, tops, channelId) {
  const tph = placeholders(tops.length);
  db.prepare(`UPDATE messages SET reply_to = NULL
    WHERE (id IN (${tph}) OR thread_id IN (${tph})) AND reply_to IS NOT NULL
      AND EXISTS (SELECT 1 FROM messages r WHERE r.id = messages.reply_to AND r.channel_id != ?
        AND r.id NOT IN (${tph}) AND (r.thread_id IS NULL OR r.thread_id NOT IN (${tph})))`)
    .run(...tops, ...tops, channelId, ...tops, ...tops);
}

// Checks inside the transaction. Returns { error } or { root, tops }, where
// tops are the selected top-level messages that actually move.
function plan(db, { from, to, rootId, ids }) {
  if (!from || !to) return { error: 'Channel not found' };
  if (from.is_dm || to.is_dm) return { error: 'Cannot move messages to or from DMs' };
  const blog = forumBlog.blogOn(db, from.id) || forumBlog.blogOn(db, to.id);
  if (blog && from.id !== to.id) return { error: 'Messages cannot be moved into or out of a blog forum' };
  if (ids.length === 0 || ids.length > MAX_SELECTED) return { error: `Select between 1 and ${MAX_SELECTED} messages` };
  if (ids.includes(rootId)) return { error: 'Pick a message that is not one of the selected ones' };

  const root = db.prepare('SELECT id, channel_id, thread_id, user_id FROM messages WHERE id = ?').get(rootId);
  if (!root) return { error: 'That message no longer exists' };
  if (root.channel_id !== to.id) return { error: 'That message is not in that channel any more' };
  if (root.thread_id) {
    return { error: ids.includes(root.thread_id)
      ? 'That message is in the thread of a selected message'
      : 'That message is a reply in a thread, and threads cannot hold threads' };
  }

  const ph = placeholders(ids.length);
  const rows = db.prepare(`SELECT id, thread_id, user_id, poll_data, persona_id, persona_username FROM messages WHERE id IN (${ph}) AND channel_id = ?`).all(...ids, from.id);
  if (rows.length !== ids.length) return { error: 'Some messages were not found in that channel' };
  const selected = new Set(ids);
  const tops = [];
  for (const r of rows) {
    if (!r.thread_id) { tops.push(r); continue; }
    if (selected.has(r.thread_id) || r.thread_id === rootId) continue; // moved with its root, or already there
    return { error: 'Some selected messages are already replies in a thread' };
  }
  if (tops.length === 0) return { error: 'Those messages are already in that thread' };
  if (blog && (root.user_id == null || tops.some(r => r.user_id !== root.user_id))) {
    return { error: 'In a blog forum, only posts by the same author can be combined into one of their posts' };
  }
  if (tops.some(r => r.poll_data)) return { error: 'Polls cannot go into a thread' };
  if (tops.some(r => r.persona_id || r.persona_username)) return { error: 'Messages sent as a persona cannot go into a thread' };
  const topIds = tops.map(r => r.id);
  const tph = placeholders(topIds.length);
  if (db.prepare(`SELECT 1 FROM role_menus WHERE message_id IN (${tph}) LIMIT 1`).get(...topIds)) {
    return { error: 'Role menus cannot go into a thread' };
  }
  if (from.is_forum && db.prepare(`SELECT 1 FROM ferry_forum_threads WHERE topic_message_id IN (${tph}) LIMIT 1`).get(...topIds)) {
    return { error: 'A topic linked to a Discord post cannot be moved into a thread' };
  }
  return { root, tops: topIds };
}

// Makes the move. `from` and `to` are channels rows: where the selection is,
// and where the base is (the same row for a move within one channel).
// Returns { error } or what moved:
//   selected      the selected top-level ids, which leave the channel feed
//   moved         every id now in the thread because of this move
//   absorbedRoots selected messages whose own replies came along
function moveIntoThread(db, { from, to, rootId, messageIds }) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter(id => Number.isInteger(id) && id > 0))];
  if (!Number.isInteger(rootId) || rootId <= 0) return { error: 'Invalid message' };

  const run = db.transaction(() => {
    const p = plan(db, { from, to, rootId, ids });
    if (p.error) return p;
    const tops = p.tops;
    const tph = placeholders(tops.length);
    const caughtUp = caughtUpReaders(db, rootId, p.root.user_id);
    const replies = db.prepare(`SELECT id, thread_id FROM messages WHERE thread_id IN (${tph})`).all(...tops);
    const absorbedRoots = [...new Set(replies.map(r => r.thread_id))].sort((a, b) => a - b);

    db.prepare(`UPDATE messages SET reply_to = thread_id WHERE thread_id IN (${tph}) AND reply_to IS NULL`).run(...tops);
    dropStrayBanners(db, tops, to.id);
    db.prepare(`UPDATE messages SET thread_id = ?, channel_id = ? WHERE thread_id IN (${tph})`).run(rootId, to.id, ...tops);
    db.prepare(`UPDATE messages SET thread_id = ?, channel_id = ? WHERE id IN (${tph})`).run(rootId, to.id, ...tops);
    if (from.id !== to.id) {
      db.prepare(`UPDATE pinned_messages SET channel_id = ? WHERE channel_id != ?
        AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)`).run(to.id, to.id, rootId);
    }
    // They are no longer threads or topics: nothing left to have read or muted.
    db.prepare(`DELETE FROM thread_reads WHERE thread_id IN (${tph})`).run(...tops);
    db.prepare(`DELETE FROM forum_topic_mutes WHERE topic_id IN (${tph})`).run(...tops);
    markCaughtUp(db, rootId, caughtUp);

    const moved = [...tops, ...replies.map(r => r.id)].sort((a, b) => a - b);
    return { selected: [...tops].sort((a, b) => a - b), moved, absorbedRoots };
  });
  return run();
}

module.exports = { MAX_SELECTED, moveIntoThread, dropStrayBanners, placeholders };

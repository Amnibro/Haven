'use strict';

// "Move to...": selected messages go to another channel. The socket handler
// (move-messages in socketHandlers/messages.js) checks who may move what;
// this file holds the rules and the database change. "Move here as thread"
// is the other kind of move, in moveToThread.js.
//
// The rules:
//  - a selected message with a thread brings its replies, and they stay its
//    replies: same thread, same order, same reply count and latest activity.
//    Left behind they would hang under a message that is no longer there
//  - a selected reply whose root is selected too moves once, with its root
//  - a selected reply whose root is not selected stays in its thread. The
//    channel feed only shows top-level messages, so such a reply means the
//    selection is out of date (someone else moved that message into a thread
//    meanwhile). Pulling it out of that thread on its own would undo their
//    move and lose its context; Move here as thread refuses the same case.
//    The rest of the selection still moves, and when nothing else is left
//    the move is refused
//  - nothing about a message changes but its channel: author, times,
//    reactions, attachments, pins, protection and self-destruct timers stay.
//    Read positions in a thread go by message id, which does not change, so
//    nobody gets an "N new" marker for replies they had already seen
//  - a reply banner that points at a message left behind is dropped, as
//    Move here as thread does, so the other channel's readers do not see a
//    line of a message from a channel they may not be able to open
//
// Everything runs in one transaction, checked again inside it, so two moves
// at once cannot both move the same message.

const { MAX_SELECTED, dropStrayBanners, placeholders } = require('./moveToThread');

// `from` and `to` are channels rows. Returns { error } or what moved:
//   moved   the selected top-level ids, which leave the source feed
//   brought replies that came along in the threads of those messages
//   kept    selected replies that stayed in their thread
function moveToChannel(db, { from, to, messageIds }) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter(id => Number.isInteger(id) && id > 0))];

  const run = db.transaction(() => {
    if (!from || !to) return { error: 'Channel not found' };
    if (from.id === to.id) return { error: 'Invalid channels' };
    if (from.is_dm || to.is_dm) return { error: 'Cannot move messages to or from DMs' };
    if (ids.length === 0 || ids.length > MAX_SELECTED) return { error: `Select between 1 and ${MAX_SELECTED} messages` };

    const rows = db.prepare(`SELECT id, thread_id FROM messages WHERE id IN (${placeholders(ids.length)}) AND channel_id = ?`)
      .all(...ids, from.id);
    if (rows.length !== ids.length) return { error: 'Some messages were not found in the source channel' };

    const selected = new Set(ids);
    const tops = [];
    const kept = [];
    for (const r of rows) {
      if (!r.thread_id) tops.push(r.id);
      else if (!selected.has(r.thread_id)) kept.push(r.id);
      // else: it moves with its root
    }
    if (tops.length === 0) return { error: 'Those messages are replies in a thread that is staying put' };
    tops.sort((a, b) => a - b);
    kept.sort((a, b) => a - b);

    const tph = placeholders(tops.length);
    const brought = db.prepare(`SELECT id FROM messages WHERE thread_id IN (${tph}) ORDER BY id`).all(...tops).map(r => r.id);

    dropStrayBanners(db, tops, to.id);
    db.prepare(`UPDATE messages SET channel_id = ? WHERE id IN (${tph}) OR thread_id IN (${tph})`).run(to.id, ...tops, ...tops);
    db.prepare(`UPDATE pinned_messages SET channel_id = ? WHERE channel_id != ?
      AND message_id IN (SELECT id FROM messages WHERE id IN (${tph}) OR thread_id IN (${tph}))`)
      .run(to.id, to.id, ...tops, ...tops);

    return { moved: tops, brought, kept };
  });
  return run();
}

module.exports = { moveToChannel };

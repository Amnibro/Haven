'use strict';

// "Move here as thread": selected messages go into the thread under another
// message in the same channel. The rules live in src/moveToThread.js.
//
//   move-messages-to-thread { code, rootId, messageIds }
//     -> { success, moved, brought } or { error }
//
// The same permission as Move to...: the admin, or Delete Messages in the
// channel, and the mover has to reach the channel (membership and its role
// gate). Everyone in the channel then hears:
//   messages-moved     the selected messages leave the feed (the event Move
//                      to... sends, so older clients drop them too)
//   messages-threaded  which thread they went to, so an open thread panel or
//                      a forum reloads
//   thread-updated     the base's reply chip and count
// No new-thread-message goes out: these are old messages that were already
// on screen, so nobody gets a sound or an "N new" marker for them.

const { utcStamp } = require('./helpers');
const { reachableChannelByCode } = require('./channelAccess');
const { moveIntoThread } = require('../moveToThread');
const forumUnread = require('../forumUnread');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, logAudit } = ctx;

  // A failed check refuses.
  function canMove(channelId) {
    if (socket.user.isAdmin) return true;
    try {
      return !!userHasPermission(socket.user.id, 'delete_message', channelId);
    } catch (err) {
      console.warn('[move-thread] permission check failed, refusing:', err.message);
      return false;
    }
  }

  // The base's thread chip, in the shape send-thread-message sends.
  function threadSummary(rootId) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(rootId).n;
    const last = db.prepare('SELECT id, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(rootId);
    const participants = db.prepare(`
      SELECT DISTINCT COALESCE(u.display_name, u.username) AS username, u.avatar, COALESCE(u.avatar_shape, 'circle') AS avatar_shape
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT 5
    `).all(rootId);
    return {
      count,
      lastReplyAt: last ? utcStamp(last.created_at) : null,
      lastReplyId: last ? last.id : null,
      participants: participants.map(p => ({ username: p.username, avatar: p.avatar, avatarShape: p.avatar_shape })),
    };
  }

  socket.on('move-messages-to-thread', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });

    const channel = reachableChannelByCode(ctx, socket.user, typeof data.code === 'string' ? data.code.trim() : '');
    if (!channel) return cb({ error: 'Channel not found' });
    if (channel.is_dm) return cb({ error: 'Cannot move messages in DMs' });
    if (!canMove(channel.id)) return cb({ error: 'You need message management permissions to move messages' });

    const rootId = data.rootId;
    let result;
    try {
      result = moveIntoThread(db, { channel, rootId, messageIds: data.messageIds });
    } catch (err) {
      console.error('Move to thread error:', err);
      return cb({ error: 'Failed to move messages' });
    }
    if (result.error) return cb({ error: result.error });
    forumUnread.forget(channel.id);

    const code = channel.code;
    const tell = (event, payload) => io.to(`channel:${code}`).emit(event, payload);
    tell('messages-moved', { channelCode: code, messageIds: result.selected, toThread: rootId });
    tell('messages-threaded', {
      channelCode: code,
      parentId: rootId,
      messageIds: result.moved,
      absorbedRoots: result.absorbedRoots,
    });
    tell('thread-updated', { channelCode: code, parentId: rootId, thread: threadSummary(rootId) });

    const brought = result.moved.length - result.selected.length;
    if (typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: 'messages_move_to_thread',
        target_type: 'channel', target_id: channel.id, target_name: channel.name,
        details: { thread: rootId, messages: result.selected.length, broughtReplies: brought, messageIds: result.selected },
      });
    }
    cb({ success: true, moved: result.selected.length, brought });
  });
};

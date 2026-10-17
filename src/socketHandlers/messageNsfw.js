'use strict';

// Mark a message NSFW, or take the mark off. The rules live in
// src/messageNsfw.js.
//
//   set-message-nsfw { messageId, nsfw }  -> { success } or { error }
//   message-nsfw { channelCode, messageId, threadId, nsfw }  to the channel
//
// A moderator marking someone else's message is recorded in the audit log.

const { isInt } = require('./helpers');
const { reachableChannel } = require('./channelAccess');
const { nsfwAllowed } = require('../messageNsfw');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, logAudit } = ctx;

  socket.on('set-message-nsfw', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!data || typeof data !== 'object' || !isInt(data.messageId) || typeof data.nsfw !== 'boolean') return reply({ error: 'Invalid request' });
    const msg = db.prepare(`SELECT m.id, m.user_id, m.channel_id, m.thread_id, m.nsfw, m.nsfw_by, c.code, c.name, c.is_dm
      FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?`).get(data.messageId);
    if (!msg || !reachableChannel(ctx, socket.user, msg.channel_id)) return reply({ error: 'Message not found' });
    // A failed check counts as no permission.
    let isMod = false;
    if (!msg.is_dm) {
      try {
        isMod = !!userHasPermission(socket.user.id, 'delete_message', msg.channel_id);
      } catch (err) {
        console.warn('[nsfw] permission check failed, refusing:', err.message);
      }
    }
    if (!nsfwAllowed({ msg, user: socket.user, isMod, nsfw: data.nsfw })) {
      return reply({ error: 'You can\'t change the NSFW mark on this message' });
    }
    db.prepare('UPDATE messages SET nsfw = ?, nsfw_by = ? WHERE id = ?')
      .run(data.nsfw ? 1 : 0, data.nsfw ? socket.user.id : null, msg.id);
    io.to(`channel:${msg.code}`).emit('message-nsfw', { channelCode: msg.code, messageId: msg.id, threadId: msg.thread_id || null, nsfw: data.nsfw });
    if (msg.user_id !== socket.user.id && !msg.is_dm && typeof logAudit === 'function') {
      logAudit({
        actor: socket.user, action: data.nsfw ? 'message_nsfw_on' : 'message_nsfw_off',
        target_type: 'channel', target_id: msg.channel_id, target_name: msg.name,
        details: { messageId: msg.id, author: msg.user_id },
      });
    }
    reply({ success: true });
  });
};

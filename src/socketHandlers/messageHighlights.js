'use strict';

// Mark a message as official, or take the mark off (see src/messageHighlights.js).

const highlights = require('../messageHighlights');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, getUserHighestRole } = ctx;

  // Any error denies.
  const allowed = (perm, channelId) => {
    try {
      return !!(socket.user.isAdmin || userHasPermission(socket.user.id, perm, channelId));
    } catch (err) {
      console.warn('[highlight] permission check failed:', err.message);
      return false;
    }
  };

  socket.on('set-message-highlight', (data) => {
    if (!socket.user || !data || typeof data !== 'object') return;
    const messageId = Number(data.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) return;
    const msg = db.prepare(`
      SELECT m.id, m.user_id, m.persona_id, m.is_webhook, c.id AS channel_id, c.code, c.is_dm
      FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?
    `).get(messageId);
    if (!msg || msg.is_dm) return;

    let highlight = null;
    if (data.on) {
      // Only on your own words: a mark speaks for the author's role.
      if (msg.user_id !== socket.user.id || msg.persona_id || msg.is_webhook) return;
      if (!allowed('highlight_messages', msg.channel_id)) {
        return socket.emit('error-msg', 'You don\'t have permission to post official messages');
      }
      highlight = highlights.mark(db, { messageId, userId: socket.user.id, channelId: msg.channel_id, getUserHighestRole });
    } else {
      // The author can take it off, and so can anyone who could delete it.
      const own = msg.user_id === socket.user.id;
      if (!own && !allowed('delete_message', msg.channel_id)) {
        return socket.emit('error-msg', 'You don\'t have permission to change that message');
      }
      highlights.unmark(db, messageId);
    }
    io.to(`channel:${msg.code}`).emit('message-highlight', { channelCode: msg.code, messageId, highlight });
  });

  // Keep official mode on: saved on the account, so every device of theirs
  // follows. Anyone may switch it; it only does something with Highlight
  // Messages.
  socket.on('set-official-mode', (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (!socket.user || !data || typeof data !== 'object' || typeof data.enabled !== 'boolean') {
      return reply({ ok: false, error: 'Invalid request' });
    }
    let officialMode;
    try {
      officialMode = highlights.setOfficialMode(db, socket.user.id, data.enabled);
    } catch (err) {
      console.warn('[highlight] saving official mode failed:', err.message);
      return reply({ ok: false, error: 'Failed to save the setting' });
    }
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === socket.user.id) s.emit('official-mode-changed', { officialMode });
    }
    reply({ ok: true, officialMode });
  });
};

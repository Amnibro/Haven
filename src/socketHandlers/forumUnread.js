'use strict';

// The forum's sidebar dot and muting single topics (see src/forumUnread.js).

const forumUnread = require('../forumUnread');

module.exports = function register(socket, ctx) {
  const { io, db } = ctx;

  // A member whose role no longer opens a gated forum is out of it too.
  // Any error denies.
  const isMember = (channelId) => {
    if (socket.user.isAdmin) return true;
    try {
      if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, socket.user.id)) return false;
      const gate = db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(channelId);
      return !!(gate && ctx.roleGateAllows(socket.user.id, gate));
    } catch (err) {
      console.warn('[forum-unread] access check failed:', err.message);
      return false;
    }
  };

  // Sent to every tab this person has open, so they all agree.
  const sendCount = (channel) => {
    let n = 0;
    try {
      n = forumUnread.countCached(db, socket.user.id, channel.id);
    } catch (err) {
      console.warn('[forum-unread] count failed:', err.message);
      return;
    }
    for (const [, s] of io.of('/').sockets) {
      if (s.user && s.user.id === socket.user.id) s.emit('forum-unread', { channelCode: channel.code, count: n });
    }
  };

  socket.on('get-forum-unread', (data) => {
    if (!socket.user || !data || typeof data.code !== 'string') return;
    const channel = db.prepare('SELECT id, code, is_forum FROM channels WHERE code = ?').get(data.code.trim());
    if (!channel || !channel.is_forum || !isMember(channel.id)) return;
    sendCount(channel);
  });

  socket.on('set-topic-mute', (data) => {
    if (!socket.user || !data || typeof data !== 'object') return;
    const topicId = Number(data.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) return;
    const channel = db.prepare(`
      SELECT c.id, c.code, c.is_forum FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ? AND m.thread_id IS NULL
    `).get(topicId);
    if (!channel || !channel.is_forum || !isMember(channel.id)) return;
    const muted = !!data.muted;
    try {
      forumUnread.setMute(db, socket.user.id, topicId, muted);
    } catch (err) {
      console.warn('[forum-unread] mute failed:', err.message);
      return socket.emit('error-msg', 'Could not change that topic');
    }
    for (const [, s] of io.of('/').sockets) {
      if (s.user && s.user.id === socket.user.id) s.emit('topic-muted', { channelCode: channel.code, topicId, muted });
    }
    sendCount(channel);
  });
};

'use strict';

// Votes on forum topics (#5742). Storage lives in src/forumVotes.js.
//
//   set-forum-votes { code, mode: 'off' | 'likes' | 'both' }   Channel Functions
//   vote-topic      { messageId, value: 1 | -1 | 0 }           0 takes a vote back
//
// Everyone viewing the forum gets the new counts live ('topic-votes'). Who
// voted which way is not broadcast; only the voter's own devices learn their
// vote ('topic-vote-mine').

const { MODES, MODE_NAMES, setVote, voteRefusal } = require('../forumVotes');
const { reachableChannel } = require('./channelAccess');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, broadcastChannelLists } = ctx;

  socket.on('set-forum-votes', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Invalid channel' });
    if (!Object.prototype.hasOwnProperty.call(MODES, data.mode)) return cb({ error: 'Invalid setting' });
    const channel = db.prepare('SELECT id, is_dm FROM channels WHERE code = ?').get(code);
    if (!channel || channel.is_dm) return cb({ error: 'Channel not found' });
    // Changed only from inside the channel, through its gate, as the other
    // channel settings are.
    if (!socket.user.isAdmin && (!reachableChannel(ctx, socket.user, channel.id)
        || !userHasPermission(socket.user.id, 'manage_channel_settings', channel.id))) {
      return cb({ error: 'You don\'t have permission to change this channel\'s settings' });
    }
    const mode = MODES[data.mode];
    try {
      db.prepare('UPDATE channels SET forum_votes = ? WHERE id = ?').run(mode, channel.id);
    } catch (err) {
      console.error('set-forum-votes error:', err);
      return cb({ error: 'Failed to save the setting' });
    }
    broadcastChannelLists();
    io.to(`channel:${code}`).emit('forum-votes-mode', { code, mode: MODE_NAMES[mode] });
    cb({ success: true, mode: MODE_NAMES[mode] });
  });

  socket.on('vote-topic', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const messageId = Number.isInteger(data.messageId) ? data.messageId : null;
    const value = data.value;
    if (!messageId || ![1, -1, 0].includes(value)) return cb({ error: 'Invalid vote' });

    const topic = db.prepare(`SELECT m.id, m.thread_id, c.id AS channel_id, c.code, c.is_forum, c.is_dm, c.forum_votes, c.role_gate
      FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?`).get(messageId);
    if (!topic || topic.thread_id || !topic.is_forum || topic.is_dm) return cb({ error: 'That is not a forum topic' });

    // Membership, role gate, ban, the forum's setting and timeouts.
    const refusal = voteRefusal(ctx, socket.user, topic, value);
    if (refusal) return cb({ error: refusal });

    let totals;
    try {
      totals = setVote(db, messageId, socket.user.id, value);
    } catch (err) {
      console.error('vote-topic error:', err);
      return cb({ error: 'Failed to save the vote' });
    }
    io.to(`channel:${topic.code}`).emit('topic-votes', { channelCode: topic.code, messageId, ...totals });
    for (const [, s] of io.sockets.sockets) {
      if (s !== socket && s.user && s.user.id === socket.user.id) {
        s.emit('topic-vote-mine', { channelCode: topic.code, messageId, value });
      }
    }
    cb({ success: true, messageId, mine: value, ...totals });
  });
};

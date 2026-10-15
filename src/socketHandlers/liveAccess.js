'use strict';

// Taking someone out of a channel's live side when they lose access to it.
// Deleting the membership row stops the next request, but a socket already in
// `channel:<code>` keeps receiving the feed, and one in the voice call keeps
// hearing it (and is moved along when the code rotates). Every path that
// removes access calls cutOff, or dropFromVoice when only the call is at
// stake, so the live side follows the database.

module.exports = function createLiveAccess({ io, state, handleVoiceLeave }) {
  const { voiceUsers, pendingVoiceLeave } = state;

  function socketsOf(userId) {
    const out = [];
    for (const [, s] of io.of('/').sockets) {
      if (s.user && s.user.id === userId) out.push(s);
    }
    return out;
  }

  // Ends the user's place in the voice call of each channel. Their client is
  // told with voice-kicked, which it already handles by leaving the call.
  function dropFromVoice(userId, codes, reason = 'You no longer have access to this channel') {
    for (const code of codes || []) {
      if (!code) continue;
      const room = voiceUsers.get(code);
      const entry = room && room.get(userId);
      if (entry) {
        const pendingKey = `${userId}:${code}`;
        const pending = pendingVoiceLeave && pendingVoiceLeave.get(pendingKey);
        if (pending) {
          clearTimeout(pending.timer);
          pendingVoiceLeave.delete(pendingKey);
        }
        const live = io.of('/').sockets.get(entry.socketId);
        const voiceSocket = live || {
          id: entry.socketId,
          user: { id: userId, displayName: entry.username, isBot: !!entry.isBot, webhookId: entry.webhookId },
          leave() {},
        };
        handleVoiceLeave(voiceSocket, code);
        if (live) live.emit('voice-kicked', { channelCode: code, reason });
      }
      for (const s of socketsOf(userId)) s.leave(`voice:${code}`);
    }
  }

  // Out of the text rooms and the voice calls of these channels, on every
  // device the user has open.
  function cutOff(userId, codes, reason) {
    const list = (codes || []).filter(Boolean);
    if (!list.length) return;
    for (const s of socketsOf(userId)) {
      for (const code of list) {
        s.leave(`channel:${code}`);
        if (s.currentChannel === code) s.currentChannel = null;
      }
    }
    for (const code of list) {
      const users = state.channelUsers.get(code);
      if (users) users.delete(userId);
    }
    dropFromVoice(userId, list, reason);
  }

  return { socketsOf, dropFromVoice, cutOff };
};

'use strict';

// New accounts wait before posting (#5742). The rule itself lives in
// src/automod.js (newAccountWaitMinutes); this is the socket side, shared by
// every handler that posts something other people see: channel messages,
// forum topics, thread replies, polls, scheduled messages and DMs.
//
// A refusal is sent as its own event rather than error-msg so the app can
// say how long is left in the reader's language and put the draft back.

function waitMessage(minutes) {
  if (!minutes) return 'Could not check whether your account can post yet. Try again in a moment.';
  if (minutes >= 120) return `New accounts can post in about ${Math.round(minutes / 60)} hours.`;
  return `New accounts can post in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

module.exports = function createPostingWait(socket, ctx) {
  const { automod, getUserEffectiveLevel } = ctx;

  // Returns null when the account may post, or { minutes, message } when it
  // must wait. minutes is 0 when the check itself failed: that refuses too,
  // because letting a failed check through would open the gate it guards.
  function youngAccountWait(channelId) {
    let minutes;
    try {
      minutes = automod.newAccountWaitMinutes({
        isAdmin: !!socket.user.isAdmin,
        createdAt: socket.user.createdAt,
        effectiveLevel: () => getUserEffectiveLevel(socket.user.id, channelId || null)
      });
    } catch (err) {
      console.warn('[automod] new-account wait check failed, refusing the post:', err.message);
      minutes = 0;
      return { minutes, message: waitMessage(minutes) };
    }
    return minutes > 0 ? { minutes, message: waitMessage(minutes) } : null;
  }

  // For handlers that answer with events: tells the poster and returns true
  // when the post must stop.
  function refuseYoungAccount(channelId) {
    const wait = youngAccountWait(channelId);
    if (!wait) return false;
    socket.emit('new-account-wait', wait);
    return true;
  }

  return { youngAccountWait, refuseYoungAccount };
};

module.exports.waitMessage = waitMessage;

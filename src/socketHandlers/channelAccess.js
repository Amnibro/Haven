'use strict';

// Whether a user can reach a channel, for handlers that are handed a channel
// id or code by the client. The admin reaches every channel except a DM they
// are not part of; anyone else needs a membership row and the channel's role
// gate. Returns the channel row, or null. Any error denies.

function reachable(ctx, user, ch) {
  if (!ch) return null;
  const member = !!ctx.db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ch.id, user.id);
  if (ch.is_dm) return member ? ch : null;
  if (user.isAdmin) return ch;
  if (!member) return null;
  return ctx.roleGateAllows(user.id, ch) ? ch : null;
}

function reachableChannel(ctx, user, channelId) {
  if (!Number.isInteger(channelId) || channelId <= 0) return null;
  try {
    return reachable(ctx, user, ctx.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId));
  } catch (err) {
    console.warn('[channel-access] check failed, denying:', err.message);
    return null;
  }
}

function reachableChannelByCode(ctx, user, code) {
  if (typeof code !== 'string' || !/^[a-f0-9]{8}$/i.test(code)) return null;
  try {
    return reachable(ctx, user, ctx.db.prepare('SELECT * FROM channels WHERE code = ?').get(code));
  } catch (err) {
    console.warn('[channel-access] check failed, denying:', err.message);
    return null;
  }
}

module.exports = { reachableChannel, reachableChannelByCode };

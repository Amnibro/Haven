'use strict';

// A bot acts for the person who made it, so it reaches no further than they
// do: nothing at all once they are banned, and only channels they could open
// themselves. Every path that looks a bot up by token or by channel applies
// these, not only the main token lookup.
const { roleGateAllows } = require('./roleGate');

// For queries that alias the webhooks table as `w`.
const CREATOR_NOT_BANNED_SQL = 'NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = w.created_by)';

function isCreatorBanned(db, createdBy) {
  if (!createdBy) return false;
  return !!db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(createdBy);
}

// Whether the creator could still read this channel: an admin always can;
// anyone else needs a membership row and to pass the channel's role gate,
// the same test the Bot Manager applies when a bot is made. A creator who
// is gone, or a bot with no creator on record, reaches nothing.
function creatorCanReachChannel(db, createdBy, channel) {
  if (!createdBy || !channel || channel.is_dm) return false;
  const creator = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(createdBy);
  if (!creator || isCreatorBanned(db, creator.id)) return false;
  if (creator.is_admin) return true;
  if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, creator.id)) return false;
  return roleGateAllows(db, creator.id, channel);
}

module.exports = { CREATOR_NOT_BANNED_SQL, isCreatorBanned, creatorCanReachChannel };

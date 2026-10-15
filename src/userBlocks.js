'use strict';

// Blocking people (Settings, Data & privacy, and the profile popup).
//
// A block is private to the person who makes it; the blocked person is never
// told. What the server does about it:
//   - in a 1:1 DM where either side blocked the other, nothing can be sent or
//     edited, and a new 1:1 DM between them cannot be started; the blocker
//     has to unblock to write to them again;
//   - someone who blocked you cannot be added to a group DM by you;
//   - DM calls between them are refused;
//   - pushes and unread counts leave out messages from people you blocked.
// Channel and group delivery is unchanged. Clients hide those messages behind
// a "Blocked message" row the reader can open one at a time.

const MAX_BLOCKS = 1000;
const DM_BLOCKED_ERROR = 'You can\'t send messages to this person.';
const GROUP_BLOCKED_ERROR = 'This person can\'t be added.';
const CALL_BLOCKED_ERROR = 'You can\'t call this person.';

/** Ids this member has blocked, oldest block first. */
function blockedIds(db, userId) {
  return db.prepare('SELECT blocked_id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at, blocked_id').all(userId).map(r => r.blocked_id);
}

/** Members who blocked `userId`. */
function blockersOf(db, userId) {
  return new Set(db.prepare('SELECT blocker_id FROM user_blocks WHERE blocked_id = ?').all(userId).map(r => r.blocker_id));
}

function blockedEitherWay(db, a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return false;
  return !!db.prepare(`
    SELECT 1 FROM user_blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1
  `).get(a, b, b, a);
}

/**
 * True when `channel` ({ id, is_dm, is_group }) is a 1:1 DM between `userId`
 * and someone either of them blocked. Group DMs, self-DMs and channels are
 * never blocked here.
 */
function dmBlocked(db, channel, userId) {
  if (!channel || !channel.is_dm || channel.is_group) return false;
  const others = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ?').all(channel.id, userId);
  return others.length === 1 && blockedEitherWay(db, userId, others[0].user_id);
}

/** Which of `candidateIds` blocked `userId`. */
function whoBlocked(db, userId, candidateIds) {
  const blockers = blockersOf(db, userId);
  return (candidateIds || []).filter(id => blockers.has(id));
}

module.exports = {
  MAX_BLOCKS, DM_BLOCKED_ERROR, GROUP_BLOCKED_ERROR, CALL_BLOCKED_ERROR,
  blockedIds, blockersOf, blockedEitherWay, dmBlocked, whoBlocked,
};

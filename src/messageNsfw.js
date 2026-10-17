'use strict';

/**
 * Marking one message NSFW, from the message menu. Forum topics have had the
 * flag since #5633 (messages.nsfw, set in the New Post window); any message
 * can now carry it, and clients blur its text, pictures, videos and link
 * cards until clicked.
 *
 * Who may set it:
 *   - the author, on their own message (in a DM, only the author),
 *   - anyone who may delete others' messages in the channel, and the admin.
 * Who may take it off: the same people, except that an author cannot lift a
 * mark a moderator put on their message. messages.nsfw_by keeps who set it.
 */

function migrateMessageNsfw(addColumn) {
  addColumn('messages', 'nsfw_by', 'INTEGER DEFAULT NULL');
}

// msg: { user_id, is_dm, nsfw, nsfw_by }; user: { id, isAdmin };
// isMod: holds delete_message in the channel.
function nsfwAllowed({ msg, user, isMod, nsfw }) {
  const mine = msg.user_id != null && msg.user_id === user.id;
  if (msg.is_dm) return mine;
  if (user.isAdmin || isMod) return true;
  if (!mine) return false;
  if (nsfw || !msg.nsfw) return true;
  return msg.nsfw_by == null || msg.nsfw_by === user.id;
}

module.exports = { migrateMessageNsfw, nsfwAllowed };

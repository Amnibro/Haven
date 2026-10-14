'use strict';

// Who gets no push for a message because of their own mutes
// (public/js/modules/app-server-mute.js):
//   - a member they muted for themselves sends them none at all;
//   - a muted server sends none except for DMs, and with "except @mentions"
//     also for messages that mention them (or @everyone / @here).
// Returns a Set of user ids to leave out.
function quietRecipients(db, { channelId, senderUserId, messageContent }) {
  const quiet = new Set();
  const isDm = !!(db.prepare('SELECT is_dm FROM channels WHERE id = ?').get(channelId) || {}).is_dm;
  const text = String(messageContent || '').toLowerCase();
  const everyone = /(?<![\w@])@(everyone|here)\b/i.test(text);
  const mentions = (u) => everyone ||
    [u.username, u.display_name].filter(Boolean).some(n => text.includes('@' + String(n).toLowerCase()));
  const rows = db.prepare(`
    SELECT p.user_id, p.key, p.value, u.username, u.display_name
    FROM user_preferences p JOIN users u ON u.id = p.user_id
    WHERE p.key IN ('server_mute', 'muted_users')
  `).all();
  for (const r of rows) {
    if (r.key === 'muted_users') {
      let ids = [];
      try { ids = JSON.parse(r.value); } catch { ids = []; } // unreadable list: nobody muted
      if (Array.isArray(ids) && ids.map(Number).includes(Number(senderUserId))) quiet.add(r.user_id);
    } else if (!isDm) {
      if (r.value === 'all' || (r.value === 'mentions' && !mentions(r))) quiet.add(r.user_id);
    }
  }
  return quiet;
}

module.exports = { quietRecipients };

'use strict';

/**
 * The is_self_dm flag on DM channels, kept out of database.js, which is
 * already past its size budget.
 *
 * A DM with yourself has one member by design; the orphan DM sweep used to
 * take it for an abandoned DM and delete it. Existing ones are a one member
 * DM whose member started it and where nobody else ever wrote. Without that
 * last check an old 1:1 DM whose partner left looked the same and became
 * notes to self (4.19.0), so databases backfilled then are corrected once.
 */

// Someone other than the DM's creator wrote in it (a deleted account's
// messages have no user_id, which counts as someone else too).
const SOMEONE_ELSE_WROTE = `EXISTS (SELECT 1 FROM messages msg
  WHERE msg.channel_id = channels.id AND msg.user_id IS NOT channels.created_by)`;

const FIXED_KEY = 'self_dm_backfill_checked';

function migrateSelfDms(db, addColumn) {
  if (addColumn('channels', 'is_self_dm', 'INTEGER DEFAULT 0')) {
    db.exec(`UPDATE channels SET is_self_dm = 1 WHERE is_dm = 1 AND COALESCE(is_group, 0) = 0
      AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = channels.id) = 1
      AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = channels.id AND m.user_id = channels.created_by)
      AND NOT ${SOMEONE_ELSE_WROTE}`);
  }
  const done = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(FIXED_KEY);
  if (done) return;
  db.transaction(() => {
    db.exec(`UPDATE channels SET is_self_dm = 0 WHERE is_self_dm = 1 AND ${SOMEONE_ELSE_WROTE}`);
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, '1')").run(FIXED_KEY);
  })();
}

module.exports = { migrateSelfDms };

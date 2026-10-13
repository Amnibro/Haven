'use strict';

// Imported Discord messages belong to no Haven account (#5771). They used to
// be stored under the admin who ran the import, which:
//   - gave every imported message that admin's role badge,
//   - let that admin edit other people's imported messages as their own,
//   - would have deleted the whole imported history with that admin's account
//     (messages.user_id cascades on delete),
//   - and made the admin's unread counts walk entire imported channels.
// The importer now stores them with no account, the way Ferry already stores
// what it relays. This moves earlier imports over once.

const DONE_KEY = 'import_authors_cleared';

function migrateImportedAuthors(db) {
  const done = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(DONE_KEY);
  if (done) return;
  db.transaction(() => {
    // Their own imported messages never counted as unread for the admin who
    // ran the import. Mark those channels read up to the import for them, so
    // they are not suddenly told about thousands of old messages.
    const pairs = db.prepare(`SELECT channel_id, user_id, MAX(id) AS last FROM messages
      WHERE imported_from = 'discord' AND user_id IS NOT NULL GROUP BY channel_id, user_id`).all();
    const markRead = db.prepare(`INSERT INTO read_positions (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`);
    for (const p of pairs) markRead.run(p.user_id, p.channel_id, p.last);
    const moved = db.prepare("UPDATE messages SET user_id = NULL WHERE imported_from = 'discord' AND user_id IS NOT NULL").run().changes;
    db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(DONE_KEY, '1');
    if (moved) console.log(`[import] ${moved} imported Discord message(s) no longer belong to the admin who imported them`);
  })();
}

module.exports = { migrateImportedAuthors, DONE_KEY };

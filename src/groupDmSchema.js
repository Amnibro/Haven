/**
 * Tables behind group DM key trust (#5733), kept out of database.js, which
 * is already past its size budget. Runs from initDatabase after the other
 * group DM tables.
 */
function migrateGroupDmTrust(db) {
  // Every signing key an account has published, never removed, so messages
  // signed before a key reset still verify afterwards.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_signing_keys (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fp         TEXT    NOT NULL,
      jwk        TEXT    NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, fp)
    );
    INSERT OR IGNORE INTO user_signing_keys (user_id, fp, jwk)
      SELECT id, json_extract(signing_key, '$.x') || '.' || json_extract(signing_key, '$.y'), signing_key
      FROM users WHERE signing_key IS NOT NULL;
  `);
  // The statement each epoch's publisher signed: the key, the group, the
  // epoch and exactly who it was shared with.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_group_epochs (
      channel_id   INTEGER NOT NULL,
      epoch        INTEGER NOT NULL,
      published_by INTEGER NOT NULL,
      sig          TEXT    NOT NULL,
      roster       TEXT    NOT NULL,
      PRIMARY KEY (channel_id, epoch)
    );
  `);
}

module.exports = { migrateGroupDmTrust };

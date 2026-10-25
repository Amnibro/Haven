'use strict';
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS dm_delivered (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
  )`);
}
const enabled = (db, uid) => (db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'read_receipts'").get(uid)?.value || 'on') !== 'off';
const latest = (db, cid) => db.prepare('SELECT MAX(id) AS m FROM messages WHERE channel_id = ? AND thread_id IS NULL').get(cid)?.m || 0;
function peerOf(db, code, uid) {
  const ch = db.prepare('SELECT id FROM channels WHERE code = ? AND is_dm = 1 AND COALESCE(is_group, 0) = 0').get(code);
  if (!ch || !db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ch.id, uid)) return null;
  const p = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ? LIMIT 1').get(ch.id, uid);
  return p ? { cid: ch.id, peer: p.user_id } : null;
}
function markDelivered(db, uid) {
  const rows = db.prepare(`SELECT c.id, c.code, (SELECT user_id FROM channel_members WHERE channel_id = c.id AND user_id != ? LIMIT 1) AS peer
    FROM channels c JOIN channel_members cm ON cm.channel_id = c.id WHERE c.is_dm = 1 AND COALESCE(c.is_group, 0) = 0 AND cm.user_id = ?`).all(uid, uid);
  const up = db.prepare('INSERT INTO dm_delivered (user_id, channel_id, last_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)');
  return rows.filter(r => r.peer).map(r => { up.run(uid, r.id, latest(db, r.id)); return { code: r.code, cid: r.id, peer: r.peer }; });
}
function status(db, cid, reader, online) {
  const read = db.prepare('SELECT last_read_message_id AS r FROM read_positions WHERE user_id = ? AND channel_id = ?').get(reader, cid)?.r || 0;
  const kept = db.prepare('SELECT last_id FROM dm_delivered WHERE user_id = ? AND channel_id = ?').get(reader, cid)?.last_id || 0;
  return { read, delivered: Math.max(read, online ? latest(db, cid) : kept) };
}
module.exports = { ensureTable, enabled, peerOf, markDelivered, status };

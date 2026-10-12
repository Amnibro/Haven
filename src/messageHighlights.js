'use strict';

// Official messages: someone whose role has Highlight Messages can mark what
// they post as said on behalf of their role. The message then carries that
// role's name and colour. The role is stored, not its look, so renaming or
// recolouring the role updates every message it marked; a deleted role
// leaves the mark with no name.

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_highlights (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function lookup(db, messageIds) {
  const out = new Map();
  if (!messageIds || !messageIds.length) return out;
  const ph = messageIds.map(() => '?').join(',');
  db.prepare(`
    SELECT h.message_id, r.name, r.color, r.color2, r.color_shimmer
    FROM message_highlights h LEFT JOIN roles r ON r.id = h.role_id
    WHERE h.message_id IN (${ph})
  `).all(...messageIds).forEach(r => out.set(r.message_id, toPayload(r)));
  return out;
}

function forMessage(db, messageId) {
  return lookup(db, [messageId]).get(messageId) || null;
}

function toPayload(row) {
  return {
    role: row.name || null,
    color: row.color || null,
    color2: row.color2 || null,
    shimmer: !!row.color_shimmer,
  };
}

// The role a message speaks for: the author's highest role in that channel.
// An admin who holds no role gets a mark with no role name.
function mark(db, { messageId, userId, channelId, getUserHighestRole }) {
  let roleId = null;
  try {
    const role = getUserHighestRole ? getUserHighestRole(userId, channelId) : null;
    roleId = role ? role.id : null;
  } catch (err) {
    console.warn('[highlight] role lookup failed:', err.message);
  }
  db.prepare('INSERT OR REPLACE INTO message_highlights (message_id, role_id, user_id) VALUES (?, ?, ?)')
    .run(messageId, roleId, userId);
  return forMessage(db, messageId);
}

function unmark(db, messageId) {
  db.prepare('DELETE FROM message_highlights WHERE message_id = ?').run(messageId);
}

module.exports = { ensureTable, lookup, forMessage, mark, unmark };

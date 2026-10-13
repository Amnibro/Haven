'use strict';

// Quotes that lead back to what they quote. The Quote action fills the box
// with "> @Name wrote:" and the quoted lines; the message that goes out also
// names the quoted message, so a click on the quote jumps to it, the way a
// reply banner does. Only a message in the same channel can be named, which
// keeps a quote from pointing anyone at a channel they cannot see.

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_quotes (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      quote_of INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE
    );
  `);
}

// Stores the link when the quoted message is in the same channel and is not
// set to disappear. Returns the quoted id, or null when nothing was stored.
function record(db, { messageId, quoteOf, channelId }) {
  if (!Number.isInteger(quoteOf) || quoteOf <= 0 || quoteOf === messageId) return null;
  const quoted = db.prepare('SELECT channel_id, destruct_at FROM messages WHERE id = ?').get(quoteOf);
  if (!quoted || quoted.channel_id !== channelId || quoted.destruct_at) return null;
  db.prepare('INSERT OR REPLACE INTO message_quotes (message_id, quote_of) VALUES (?, ?)').run(messageId, quoteOf);
  return quoteOf;
}

function lookup(db, messageIds) {
  const out = new Map();
  if (!messageIds || !messageIds.length) return out;
  const ph = messageIds.map(() => '?').join(',');
  db.prepare(`SELECT message_id, quote_of FROM message_quotes WHERE message_id IN (${ph})`)
    .all(...messageIds).forEach(r => out.set(r.message_id, r.quote_of));
  return out;
}

module.exports = { ensureTable, record, lookup };

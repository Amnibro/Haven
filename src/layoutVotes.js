'use strict';
const CATALOG = Object.freeze([
  ['carousel', 'Carousel', 'The conversation that needs you sits in the middle, the one you cleared on the left, the next one on the right.', 'FocusLayout'],
  ['focus-classic', 'Focus Classic', 'A rail with Server, DMs, Activity and You shows one list at a time beside the chat.', 'FocusClassicLayout'],
  ['tethers', 'Floating threads', 'Messages float above a centered message box, tethered to it. Click one to aim your reply at that person.', ''],
  ['queue', 'Queue', 'The next thing to answer is already aimed. Send, and the one after it lines up.', ''],
  ['lanes', 'Lanes', 'Four conversations side by side, each flowing down into one message box.', ''],
  ['wheel', 'Wheel', 'Conversations keep a fixed seat around the box, each with its own hotkey.', ''],
  ['hub', 'Hub', 'Queue and Lanes in one view, with a rail from the person you answer into the box.', ''],
  ['calm', 'Calm Focus', 'A short Now list (Needs you, New, Pinned) beside the chat. Quiet channels stay hidden.', ''],
  ['reading', 'Reading column', 'Just the chat in a comfortable column, with everything else one key away.', ''],
  ['inbox', 'Inbox', 'An email-style list of conversations with previews, and the open one beside it.', ''],
  ['palette', 'Jump palette', 'Chat only. Ctrl+K jumps anywhere.', ''],
  ['today', 'Today page', 'A start page that sums up what happened today across your servers.', ''],
  ['floorplan', 'Floor plan', 'Your server drawn as rooms, with people where they are talking.', ''],
  ['daily', 'The Daily', 'Your conversations laid out like a newspaper front page.', ''],
  ['stage', 'Stage', 'Big type, one voice at a time.', ''],
  ['desk', 'Desk', 'Conversations as cards you arrange on a desk and file away.', ''],
  ['terminal', 'Terminal', 'Haven as a tiled console in amber.', ''],
  ['letters', 'Letters', 'Slow, calm correspondence, one letter at a time.', '']
].map(([id, name, description, layout]) => Object.freeze({ id, name, description, layout, image: `/img/focus-concepts/${id}.webp` })));
const IDS = new Set(CATALOG.map(c => c.id));
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS layout_votes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    layout TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, layout)
  )`);
}
function tally(db) { return Object.fromEntries(db.prepare('SELECT layout, COUNT(*) AS n FROM layout_votes GROUP BY layout').all().filter(r => IDS.has(r.layout)).map(r => [r.layout, r.n])); }
function mine(db, userId) { return db.prepare('SELECT layout FROM layout_votes WHERE user_id = ?').all(userId).map(r => r.layout).filter(id => IDS.has(id)); }
function setVote(db, userId, id, on) {
  if (!IDS.has(id)) return false;
  on ? db.prepare('INSERT OR IGNORE INTO layout_votes (user_id, layout) VALUES (?, ?)').run(userId, id) : db.prepare('DELETE FROM layout_votes WHERE user_id = ? AND layout = ?').run(userId, id);
  return true;
}
module.exports = { CATALOG, ensureTable, tally, mine, setVote };

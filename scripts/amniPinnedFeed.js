'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = process.env.HAVEN_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'haven-amniscient');
process.env.HAVEN_DATA_DIR = dataDir;
const { initDatabase } = require('../src/database');
const ORIGIN = process.env.HAVEN_WEBHOOK_ORIGIN || 'http://127.0.0.1:3010';
const FILE = process.env.FEED_FILE;
const NAME = process.env.FEED_CHANNEL || 'project-feed';
const HOOK = process.env.FEED_HOOK || 'Feed';
const CATEGORY = process.env.FEED_CATEGORY || 'Staff';
const TOPIC = process.env.FEED_TOPIC || '';
const STAMP = /^\*updated [^\n]*\*$/m;
const STATE = path.join(dataDir, `pinned-feed-${NAME}.json`);
const db = initDatabase();
const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
const byName = () => db.prepare('SELECT * FROM channels WHERE name = ? AND COALESCE(is_dm,0) = 0 AND parent_channel_id IS NULL').get(NAME);
function ensureChannel() {
  const ch = byName() || (db.prepare("INSERT INTO channels (name, code, created_by, position, category, topic, is_private, read_only, text_enabled, media_enabled) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM channels), ?, ?, 1, 1, 1, 1)").run(NAME, crypto.randomBytes(4).toString('hex'), admin.id, CATEGORY, TOPIC.slice(0, 256)), byName());
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch.id, admin.id);
  return ch;
}
function ensureHook(ch) {
  const row = db.prepare('SELECT token FROM webhooks WHERE channel_id = ? AND name = ? AND is_active = 1').get(ch.id, HOOK);
  return row ? row.token : (db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, is_active) VALUES (?, ?, ?, ?, 1)').run(ch.id, HOOK, crypto.randomBytes(32).toString('hex'), admin.id), ensureHook(ch));
}
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 1)); fs.renameSync(STATE + '.tmp', STATE); };
async function main() {
  const content = fs.readFileSync(FILE, 'utf8').trim().slice(0, 4000);
  const hash = crypto.createHash('sha256').update(content.replace(STAMP, '')).digest('hex');
  const ch = ensureChannel();
  const token = ensureHook(ch);
  const st = loadState();
  const alive = st.message_id && db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(st.message_id, ch.id);
  if (alive && st.hash === hash) return console.log('unchanged');
  const res = await fetch(`${ORIGIN}/api/webhooks/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, username: HOOK }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.message_id) throw new Error(`post failed ${res.status} ${JSON.stringify(body)}`);
  alive && await fetch(`${ORIGIN}/api/webhooks/${token}/messages/${st.message_id}`, { method: 'DELETE' });
  db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(body.message_id, ch.id, admin.id);
  saveState({ hash, message_id: body.message_id, at: new Date().toISOString() });
  console.log(`posted ${body.message_id} in #${NAME}${alive ? `, replaced ${st.message_id}` : ''}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

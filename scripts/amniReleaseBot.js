'use strict';

// Release Notes bot. Every AMNI_RELEASE_POLL_MIN minutes it checks each
// product's GitHub releases and changelog (see amniReleaseSources.js). A
// version it hasn't seen is posted to that product's page and echoed to
// #announcements, the page's pinned "latest release" moves to it, and the
// overview's "Current version" line and the channel topic are updated.
//
// The first run only records what already exists, so nothing old is posted.
//   node scripts/amniReleaseBot.js            run forever
//   node scripts/amniReleaseBot.js --once     one pass, then exit
//   node scripts/amniReleaseBot.js --dry-run  print what would post

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = process.env.HAVEN_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'haven-amniscient');
process.env.HAVEN_DATA_DIR = dataDir;

const { initDatabase } = require('../src/database');
const { SOURCES, releasesFor, formatRelease, normVersion } = require('./amniReleaseSources');

const ORIGIN = process.env.HAVEN_WEBHOOK_ORIGIN || 'http://127.0.0.1:3010';
const POLL_MIN = Number(process.env.AMNI_RELEASE_POLL_MIN || 15);
const MAX_PER_PASS = 3;
const STATE = path.join(dataDir, 'release-bot-state.json');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');

const db = initDatabase();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}

function saveState(state) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE);
}

function channel(name) {
  return db.prepare('SELECT * FROM channels WHERE name = ? AND COALESCE(is_dm,0) = 0 AND parent_channel_id IS NULL').get(name);
}

function hookToken(ch) {
  const row = ch && db.prepare("SELECT token FROM webhooks WHERE channel_id = ? AND name = 'Release Notes' AND is_active = 1").get(ch.id);
  return row && row.token;
}

async function send(ch, content) {
  const token = hookToken(ch);
  if (!token) throw new Error(`no Release Notes webhook in #${ch && ch.name}`);
  const res = await fetch(`${ORIGIN}/api/webhooks/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 4000), username: 'Release Notes', avatar_url: undefined })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.message_id) throw new Error(`webhook ${res.status}: ${body.error || 'no message id'}`);
  return body.message_id;
}

function repin(ch, messageId) {
  const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (!admin) return;
  // Unpin the previous release post; the overview pin stays.
  const old = db.prepare(`
    SELECT p.message_id FROM pinned_messages p JOIN messages m ON m.id = p.message_id
    WHERE p.channel_id = ? AND m.webhook_username = 'Release Notes'
  `).all(ch.id);
  old.forEach((r) => db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(r.message_id));
  db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(messageId, ch.id, admin.id);
}

function refreshPage(ch, product, rel) {
  const v = `v${normVersion(rel.version)}${rel.date ? ` (${rel.date})` : ''}`;
  const overview = db.prepare(`
    SELECT id, content FROM messages WHERE channel_id = ? AND imported_from = 'amni-page' AND content LIKE '# %' ORDER BY id LIMIT 1
  `).get(ch.id);
  if (overview) {
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(overview.content.replace(/^\*\*Current version:\*\* .*$/m, `**Current version:** ${v}`), overview.id);
  }
  const tagline = String(ch.topic || '').replace(/ · v[^ ]+$/, '');
  db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(`${tagline} · v${normVersion(rel.version)}`.slice(0, 256), ch.id);
}

async function pass(state) {
  let posted = 0;
  const first = !state;
  state = state || { seen: {} };
  for (const product of Object.keys(SOURCES)) {
    const rels = releasesFor(product);
    const seen = new Set(state.seen[product] || []);
    if (first) {
      state.seen[product] = rels.map((r) => r.key);
      continue;
    }
    const fresh = rels.filter((r) => !seen.has(r.key)).slice(0, MAX_PER_PASS).reverse();
    for (const rel of fresh) {
      const text = formatRelease(product, rel);
      const page = channel(product);
      if (DRY) {
        console.log(`--- would post to #${product}\n${text}\n`);
        seen.add(rel.key);
        continue;
      }
      try {
        const id = await send(page, text);
        repin(page, id);
        if (rel === rels[0]) refreshPage(page, product, rel);
        const ann = channel('announcements');
        if (ann) {
          await send(ann, `🚀 **${product} v${normVersion(rel.version)}**${rel.title ? ` · ${rel.title}` : ''}\nNotes on the ${product} page.${rel.url ? ` ${rel.url}` : ''}`).catch((e) => console.warn('[release-bot] announce:', e.message));
        }
        seen.add(rel.key);
        posted++;
        console.log(`[release-bot] posted ${product} v${normVersion(rel.version)}`);
      } catch (err) {
        console.warn(`[release-bot] ${product} v${rel.version}:`, err.message);
      }
    }
    // Versions older than the newest few are marked seen so a backfill never floods.
    rels.slice(MAX_PER_PASS).forEach((r) => seen.add(r.key));
    state.seen[product] = [...seen];
  }
  if (!DRY) saveState(state);
  if (first) console.log(`[release-bot] baseline recorded for ${Object.keys(state.seen).length} products; new versions from now on get posted.`);
  return { state, posted };
}

async function main() {
  let state = loadState();
  ({ state } = await pass(state));
  if (args.has('--once') || DRY) return;
  console.log(`[release-bot] watching ${Object.keys(SOURCES).length} products every ${POLL_MIN} min`);
  setInterval(() => {
    pass(loadState() || state).then((r) => { state = r.state; }).catch((e) => console.warn('[release-bot]', e.message));
  }, POLL_MIN * 60 * 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });

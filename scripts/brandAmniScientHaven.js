'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const dataDir = process.env.HAVEN_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Haven-AmniScient');
process.env.HAVEN_DATA_DIR = dataDir;

const { ENV_PATH, UPLOADS_DIR } = require('../src/paths');
const { initDatabase } = require('../src/database');

const SITE = 'https://amni-scient.com';
const PRODUCTS = {
  Braid: `${SITE}/braid`,
  Symphony: `${SITE}/symphony.html`,
  'Grok-Remote': `${SITE}/grok-remote.html`,
  'Amni-OS': `${SITE}/amni-os.html`,
  'Amni-AI': `${SITE}/amni-ai.html`,
  'Amni-Browse': `${SITE}/amni-browse.html`,
  'Amni-Calc': `${SITE}/amni-calc.html`,
  'Amni-Explore': `${SITE}/amni-explore.html`,
  'Amni-Space': `${SITE}/amni-space.html`,
  'Amni-Weather': `${SITE}/amni-weather.html`,
  'Amni-Game': `${SITE}/game/v2/`,
  'Amni-Learn': `${SITE}/amni-learn.html`,
  'Amni-LLM': `${SITE}/amni-llm.html`,
  'Amni-Connect': `${SITE}/amni-connect.html`,
  'Amni-Code': `${SITE}/amni-code.html`,
  'Amni-Core': `${SITE}/amni-core.html`,
  'Amni-Haven': `${SITE}/amni-haven.html`,
  HedgeDoc: `${SITE}/amni-hedgedoc.html`,
  'Amni-Crypt': `${SITE}/amni-crypt.html`,
  'Amni-Life': `${SITE}/amni-life.html`,
  'Amni-Prayer': `${SITE}/amni-prayer.html`,
  'Amni-Type': `${SITE}/amni-type.html`,
  'Amni-Mail': `${SITE}/amni-mail.html`
};

const GUIDES = {
  general: 'This is the hangout room. Product talk can live in that product\'s channel. Bugs and requests go in the Feedback forums so they stay as topics I can work.\n\nSite: https://amni-scient.com\nAndroid client: https://amni-scient.com/amni-haven.html\nWant builds? Open #introductions and take the Tester role. Prerelease APKs and packages drop in #prerelease.',
  announcements: 'Staff-only posts. Chat stays in #general.',
  introductions: 'Say who you are and what you want to try. Click the flask on the Tester menu in this channel if you want pings when a build is ready. That also opens #prerelease.',
  testers: 'People who opted into testing. I will ping here when something needs eyes. Files live in #prerelease. If you wandered in without the role, grab Tester in #introductions.',
  prerelease: 'Unsigned / prerelease drops. APK, zip, msi, exe, nupkg — attach the file and put product + version in the same message (example: Amni-Haven 0.4.2-pre android).\n\nTreat these as tester bits: sideload at your own risk, do not ship them as store builds. Chat about a drop here; file bugs in #bug-reports.\n\nUpload cap on this server is 256 MB. Haven will warn on exe/msi before download. Play-store / signed releases stay on the product pages.',
  'bug-reports': 'One bug per topic. Tag the product. Include OS, version, and what you expected. Screenshots help. Feature ideas go in #feature-requests.',
  'feature-requests': 'One request per topic. Tag the product. Say what you were trying to do, not just a widget name.',
  voice: 'Talk here. Camera is optional. Join the voice channel from the header. If audio is one-way, say so in #general — that is usually NAT, not the room.',
  video: 'Camera and screen share. Same join control as #voice. Keep #voice for audio-only hangouts.'
};

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
}

function ensureEnvFlag() {
  if (!fs.existsSync(ENV_PATH)) return;
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  if (!/HAVEN_ALLOW_PRIVATE_CALLBACKS=/m.test(env)) {
    env += '\nHAVEN_ALLOW_PRIVATE_CALLBACKS=true\n';
    fs.writeFileSync(ENV_PATH, env);
  }
}

function makeArt() {
  const py = path.join(__dirname, 'makeAmniScientBrandArt.py');
  const r = spawnSync('python', [py], { env: { ...process.env, HAVEN_DATA_DIR: dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'brand art failed');
}

function wipeGuides(db) {
  const ids = db.prepare("SELECT id FROM messages WHERE imported_from = 'amni-guide'").all().map((r) => r.id);
  if (!ids.length) return;
  db.prepare(`DELETE FROM pinned_messages WHERE message_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  db.prepare("DELETE FROM messages WHERE imported_from = 'amni-guide'").run();
}

function postGuide(db, channel, text, adminId) {
  const msg = db.prepare(`
    INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, imported_from)
    VALUES (?, NULL, ?, 1, 'Guide', 'amni-guide')
  `).run(channel.id, text);
  if (adminId) {
    db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(msg.lastInsertRowid, channel.id, adminId);
  }
}

function ensureGuideWebhook(db, generalId) {
  let row = db.prepare("SELECT * FROM webhooks WHERE name = 'Guide' AND channel_id = ?").get(generalId);
  if (!row) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`
      INSERT INTO webhooks (channel_id, name, token, callback_url, subscribed_events, is_active)
      VALUES (?, 'Guide', ?, 'http://127.0.0.1:3012/hook', 'member-joined', 1)
    `).run(generalId, token);
    row = db.prepare("SELECT * FROM webhooks WHERE name = 'Guide' AND channel_id = ?").get(generalId);
  } else {
    db.prepare("UPDATE webhooks SET callback_url = 'http://127.0.0.1:3012/hook', subscribed_events = 'member-joined', is_active = 1 WHERE id = ?").run(row.id);
  }
  return row;
}

ensureEnvFlag();
makeArt();
const db = initDatabase();
const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
const adminId = admin ? admin.id : null;

setSetting(db, 'server_name', 'Amni-Scient');
setSetting(db, 'server_title', 'Amni-Scient community');
setSetting(db, 'server_icon', '/uploads/amni-icon.png');
setSetting(db, 'server_banner', '/uploads/amni-banner.png');
setSetting(db, 'default_theme', 'file:amni-scient.theme.css');
setSetting(db, 'published_themes', JSON.stringify([
  'amni-scient.theme.css',
  'amni-scient-light.theme.css',
  'braid.theme.css',
  'braid-light.theme.css'
]));
setSetting(db, 'max_upload_mb', '256');
setSetting(db, 'welcome_message', 'Hey {user}. Pinned Guide posts in each channel say what that room is for. Product channels have the live link. Want builds? Take Tester in #introductions. APKs and packages are in #prerelease.');

wipeGuides(db);

const channels = db.prepare('SELECT * FROM channels WHERE COALESCE(is_dm, 0) = 0').all();
for (const ch of channels) {
  if (PRODUCTS[ch.name]) {
    const url = PRODUCTS[ch.name];
    db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(`Open ${ch.name}: ${url}`, ch.id);
    postGuide(db, ch, `${ch.name}\nUse it here: ${url}\nTalk about this product in this channel. File bugs in #bug-reports and ideas in #feature-requests, one topic each.`, adminId);
    continue;
  }
  if (GUIDES[ch.name]) {
    const topic = ch.name === 'general'
      ? 'Hang out. Product links live in each product channel.'
      : GUIDES[ch.name].split('\n')[0].slice(0, 256);
    db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, ch.id);
    postGuide(db, ch, GUIDES[ch.name], adminId);
  }
}

const general = db.prepare("SELECT * FROM channels WHERE name = 'general' AND COALESCE(is_dm,0)=0").get();
if (general) {
  const catalog = Object.entries(PRODUCTS).map(([n, u]) => `${n}: ${u}`).join('\n');
  postGuide(db, general, `Product index (same links as the product channels):\n${catalog}`, adminId);
  ensureGuideWebhook(db, general.id);
}

const intros = db.prepare("SELECT * FROM channels WHERE name = 'introductions' AND COALESCE(is_dm,0)=0").get();
const tester = db.prepare("SELECT * FROM roles WHERE name = 'Tester' AND scope = 'server'").get();
if (adminId && intros && tester) {
  const existing = db.prepare('SELECT message_id FROM role_menus WHERE channel_id = ?').get(intros.id);
  const menuText = 'Want to test builds? Click the flask. That puts you in #testers and #prerelease so you get pings and the APKs.';
  if (!existing) {
    const msg = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(intros.id, adminId, menuText);
    db.prepare('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)').run(
      msg.lastInsertRowid, intros.id, adminId, 'Tester', JSON.stringify({ roles: [{ roleId: tester.id, emoji: '🧪' }] })
    );
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(msg.lastInsertRowid, adminId, '🧪');
  } else {
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(menuText, existing.message_id);
  }
}

if (!fs.existsSync(path.join(UPLOADS_DIR, 'amni-icon.png'))) {
  console.warn('Icon missing at', path.join(UPLOADS_DIR, 'amni-icon.png'));
}
console.log('Branded. Themes: Amni-Scient + light + Braid. Login title: Amni-Scient community.');

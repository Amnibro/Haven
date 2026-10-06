'use strict';

// Lays out the Amni-Scient community: categories, channels, roles, access and
// the product pages. Safe to re-run: channels are matched by name, and every
// post this script makes is tagged imported_from = 'amni-page' and replaced.
//
// Order: seedAmniScientCommunity.js -> brandAmniScientHaven.js -> this.
// Run it with Haven stopped; clients only see direct DB writes after a reload.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dataDir = process.env.HAVEN_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'haven-amniscient');
process.env.HAVEN_DATA_DIR = dataDir;

const { initDatabase } = require('../src/database');
const { MEMBER_PERMS, MOD_PERMS } = require('../src/roleDefaults');
const { SOURCES, releasesFor, formatRelease, normVersion } = require('./amniReleaseSources');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'amniScientProducts.json'), 'utf8'));
const PRODUCTS = catalog.products;
const PRODUCT_NAMES = PRODUCTS.map((p) => p.name);
const TAG = 'amni-page';
const BOT_NAME = 'Amni-Scient';
const BOT_AVATAR = '/uploads/amni-icon.png';

const db = initDatabase();
const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
if (!admin) {
  console.error('No admin yet. Register amnibro first.');
  process.exit(1);
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
}

function hexCode() {
  let code;
  do { code = crypto.randomBytes(4).toString('hex'); } while (db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code));
  return code;
}

// ── Roles ────────────────────────────────────────────────
function role(name) {
  return db.prepare("SELECT * FROM roles WHERE name = ? AND scope = 'server'").get(name);
}

function grant(roleRow, perms) {
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
  perms.forEach((p) => ins.run(roleRow.id, p));
}

const member = role('Member');
const mod = role('Mod');
const tester = role('Tester');
if (!member || !mod || !tester) {
  console.error('Missing Member/Mod/Tester role. Run seedAmniScientCommunity.js first.');
  process.exit(1);
}
grant(member, MEMBER_PERMS);
grant(mod, [...MOD_PERMS, 'read_only_override', 'view_audit_log']);
grant(tester, MEMBER_PERMS);
db.prepare('UPDATE roles SET max_upload_mb = NULL WHERE id = ?').run(member.id);
db.prepare('UPDATE roles SET max_upload_mb = 256, color = ? WHERE id = ?').run('#C89B4E', tester.id);
db.prepare('UPDATE roles SET max_upload_mb = 256 WHERE id = ?').run(mod.id);

// ── Channel layout ───────────────────────────────────────
const typeTags = [
  { name: 'Crash', emoji: '💥' }, { name: 'UI', emoji: '🖼️' }, { name: 'Install', emoji: '📦' },
  { name: 'Voice', emoji: '🎙️' }, { name: 'Other', emoji: '🐛' }
];
const productTags = PRODUCT_NAMES.map((n) => ({ name: n, emoji: '' }));

const gateMod = { mode: 'any', roles: [mod.id] };
const gateTester = { mode: 'any', roles: [tester.id, mod.id] };

const LAYOUT = [
  { name: 'welcome', category: 'Start Here', readOnly: true, topic: 'Start here: how this server works and where things live.' },
  { name: 'rules', category: 'Start Here', readOnly: true, topic: 'Short and enforced.' },
  { name: 'announcements', category: 'Start Here', readOnly: true, announcement: true, topic: 'Releases and news. Every product release is echoed here.' },
  { name: 'introductions', category: 'Start Here', slowMode: 30, topic: 'Say hi. Grab the Tester role here if you want builds.' },
  { name: 'general', category: 'Community', topic: 'Hang out. Product questions go in #product-talk.' },
  { name: 'product-talk', category: 'Community', forum: true, tags: productTags, topic: 'Questions and discussion, one topic per thread. Tag the product.' },
  { name: 'show-and-tell', category: 'Community', slowMode: 10, topic: 'Share what you made or set up with Amni-Scient tools. Screenshots welcome.' },
  ...catalog.groups.flatMap((g) => PRODUCTS.filter((p) => p.group === g).map((p) => ({
    name: p.name, category: g, readOnly: true, product: p,
    topic: p.tagline
  }))),
  { name: 'bug-reports', category: 'Feedback', forum: true, tags: [...typeTags, ...productTags], topic: 'One bug per topic. Tag the product and the kind of bug.' },
  { name: 'feature-requests', category: 'Feedback', forum: true, tags: [{ name: 'Small', emoji: '🔹' }, { name: 'Big', emoji: '🔶' }, ...productTags], topic: 'One idea per topic. Tag the product.' },
  { name: 'testers', category: 'Testing', gate: gateTester, topic: 'Tester chat. Builds drop in #prerelease; talk about them here.' },
  { name: 'prerelease', category: 'Testing', gate: gateTester, readOnly: true, announcement: true, topic: 'Prerelease builds. Staff posts only; discussion goes in #testers.' },
  { name: 'voice', category: 'Voice', voice: true, topic: 'Drop in and talk. Camera optional.' },
  { name: 'video', category: 'Voice', voice: true, streams: true, topic: 'Camera and screen share.' },
  { name: 'staff', category: 'Staff', gate: gateMod, private: true, topic: 'Mods and admin only.' },
  { name: 'mod-log', category: 'Staff', gate: gateMod, private: true, readOnly: true, topic: 'Automod actions land here.' }
];

const CATEGORIES = ['Start Here', 'Community', ...catalog.groups, 'Feedback', 'Testing', 'Voice', 'Staff'];

const byName = (name) => db.prepare('SELECT * FROM channels WHERE name = ? AND COALESCE(is_dm,0) = 0 AND parent_channel_id IS NULL').get(name);

function upsertChannel(spec, position) {
  let ch = byName(spec.name);
  if (!ch) {
    db.prepare('INSERT INTO channels (name, code, created_by, position) VALUES (?, ?, ?, ?)').run(spec.name, hexCode(), admin.id, position);
    ch = byName(spec.name);
  }
  db.prepare(`
    UPDATE channels SET category = ?, position = ?, topic = ?, read_only = ?, is_forum = ?, forum_tags = ?,
      voice_enabled = ?, streams_enabled = ?, slow_mode_interval = ?, notification_type = ?,
      is_private = ?, role_gate = ?, text_enabled = 1, media_enabled = 1
    WHERE id = ?
  `).run(
    spec.category, position, (spec.topic || '').slice(0, 256), spec.readOnly ? 1 : 0, spec.forum ? 1 : 0,
    spec.tags ? JSON.stringify(spec.tags.slice(0, 40)) : null,
    spec.voice ? 1 : 0, spec.streams ? 1 : 0, spec.slowMode || 0, spec.announcement ? 'announcement' : 'default',
    spec.private ? 1 : 0, spec.gate ? JSON.stringify(spec.gate) : null, ch.id
  );
  return byName(spec.name);
}

const channels = {};
db.transaction(() => {
  LAYOUT.forEach((spec, i) => { channels[spec.name] = upsertChannel(spec, i + 1); });
  // The old flat "Products" category is gone; anything left there would float.
  db.prepare("UPDATE channels SET category = 'Community' WHERE category = 'Products'").run();
})();

// Membership: everyone in open channels, gated channels follow their roles.
const users = db.prepare('SELECT id FROM users').all();
const joinIns = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
const gatedIns = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, via_role_gate) VALUES (?, ?, 1)');
const openIds = [];
db.transaction(() => {
  for (const spec of LAYOUT) {
    const ch = channels[spec.name];
    if (spec.gate) {
      const holders = db.prepare(`SELECT DISTINCT user_id FROM user_roles WHERE channel_id IS NULL AND role_id IN (${spec.gate.roles.map(() => '?').join(',')})`).all(...spec.gate.roles);
      holders.forEach((h) => gatedIns.run(ch.id, h.user_id));
      joinIns.run(ch.id, admin.id);
      continue;
    }
    openIds.push(ch.id);
    users.forEach((u) => joinIns.run(ch.id, u.id));
  }
})();

// ── Server settings ──────────────────────────────────────
setSetting('channel_sort_mode', 'manual');
setSetting('channel_cat_sort', 'manual');
setSetting('channel_cat_order', JSON.stringify(CATEGORIES));
setSetting('default_join_channels', JSON.stringify(openIds));
setSetting('max_upload_mb', '25');
setSetting('guests_enabled', 'true');
setSetting('guest_channels', ['welcome', 'rules', 'announcements'].map((n) => channels[n].id).join(','));
setSetting('registration_rate_limit_enabled', 'true');
setSetting('automod_enabled', 'true');
setSetting('automod_log_channel', channels['mod-log'].code);
setSetting('welcome_message', 'Welcome, {user}. Start in #welcome for the map of this place. Product pages are in the sidebar by category; questions go in #product-talk.');
const addDomain = db.prepare("INSERT OR IGNORE INTO automod_domains (domain, mode, include_subdomains, note) VALUES (?, 'allow', 1, 'Amni-Scient')");
['amni-scient.com', 'amniscient.com', 'huggingface.co', 'flathub.org', 'archlinux.org'].forEach((d) => { try { addDomain.run(d); } catch {} });

// ── Posts ────────────────────────────────────────────────
function wipe(ch) {
  const ids = db.prepare('SELECT id FROM messages WHERE channel_id = ? AND imported_from = ?').all(ch.id, TAG).map((r) => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM pinned_messages WHERE message_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...ids);
}

function post(ch, content, { pin = false, name = BOT_NAME } = {}) {
  const r = db.prepare(`
    INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar, imported_from)
    VALUES (?, NULL, ?, 1, ?, ?, ?)
  `).run(ch.id, content, name, BOT_AVATAR, TAG);
  if (pin) db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(r.lastInsertRowid, ch.id, admin.id);
  return r.lastInsertRowid;
}

// Brand guides from brandAmniScientHaven.js don't belong on product pages.
for (const p of PRODUCTS) {
  const ch = channels[p.name];
  const ids = db.prepare("SELECT id FROM messages WHERE channel_id = ? AND imported_from = 'amni-guide'").all(ch.id).map((r) => r.id);
  ids.forEach((id) => { db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(id); db.prepare('DELETE FROM messages WHERE id = ?').run(id); });
}

const images = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(__dirname, 'amniScientProductImages.py')], {
  env: { ...process.env, HAVEN_DATA_DIR: dataDir }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
}));

const groupList = catalog.groups.map((g) => `**${g}:** ${PRODUCTS.filter((p) => p.group === g).map((p) => p.name).join(' · ')}`).join('\n');

wipe(channels.welcome);
post(channels.welcome, [
  '# Welcome to Amni-Scient',
  'This is the home of every Amni-Scient product: news, help, testing and the people who use them.',
  '',
  '## How it\'s laid out',
  '- **Start Here:** this page, #rules, #announcements (every release is echoed there) and #introductions.',
  '- **Community:** #general to hang out, #product-talk for questions (one thread per topic, tagged by product), #show-and-tell for what you built.',
  '- **Product pages:** one read-only page per product, grouped by category. Each has what it is, its key features with screenshots, where to get it, and every release as it ships.',
  '- **Feedback:** #bug-reports and #feature-requests. One topic each, tag the product.',
  '- **Testing:** take the 🧪 Tester role in #introductions to open #testers and #prerelease.',
  '- **Voice:** #voice to talk, #video for camera and screen share.',
  '',
  '## Products',
  groupList,
  '',
  'Website: https://amni-scient.com'
].join('\n'), { pin: true });

wipe(channels.rules);
post(channels.rules, [
  '# Rules',
  '1. **Be decent.** No harassment, hate, slurs or personal attacks.',
  '2. **Keep it on topic.** Product questions in #product-talk, bugs and ideas in the Feedback forums, everything else in #general.',
  '3. **No spam or self-promotion.** New accounts can\'t post links for their first 24 hours.',
  '4. **Nothing illegal, NSFW or malicious.** That includes cracked software, malware and other people\'s private info.',
  '5. **Prerelease builds stay here.** Don\'t repost tester builds elsewhere.',
  '6. **Mods have the final word.** Disagree? Message a mod rather than arguing in channel.',
  '',
  'Breaking these gets a warning, then a mute, then a ban, depending on how bad it is.'
].join('\n'), { pin: true });

let pages = 0;
let shots = 0;
for (const p of PRODUCTS) {
  const ch = channels[p.name];
  const src = SOURCES[p.name] || {};
  wipe(ch);
  const rels = releasesFor(p.name);
  const latest = rels[0];
  const version = latest ? `v${normVersion(latest.version)}${latest.date ? ` (${latest.date})` : ''}` : 'see the product page';
  post(ch, [
    `# ${p.name}`,
    `*${p.tagline}*`,
    '',
    `**Get it:** ${src.page || 'https://amni-scient.com'}`,
    `**Current version:** ${version}`,
    `**Questions:** #product-talk, tagged ${p.name}`,
    '**Found a bug? Have an idea?** #bug-reports and #feature-requests, one topic each.',
    '',
    '## Key features',
    ...p.features.map((f) => `- **${f.name}:** ${f.desc}`)
  ].join('\n'), { pin: true });
  for (const f of p.features) {
    if (!f.image || !images[f.image]) continue;
    post(ch, `### ${f.name}\n${f.desc}\n${images[f.image]}`);
    shots++;
  }
  if (latest) {
    post(ch, `**Latest release**\n${formatRelease(p.name, latest)}`, { name: 'Release Notes', pin: true });
  }
  db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(`${p.tagline.slice(0, 200)} · ${latest ? `v${normVersion(latest.version)}` : ''}`.replace(/ · $/, ''), ch.id);
  pages++;
}

// One Release Notes webhook per product page plus #announcements, for the bot.
const hookIns = db.prepare('INSERT INTO webhooks (channel_id, name, token, avatar_url, created_by, is_active) VALUES (?, ?, ?, ?, ?, 1)');
for (const name of [...PRODUCT_NAMES, 'announcements']) {
  const ch = channels[name];
  if (!db.prepare("SELECT 1 FROM webhooks WHERE channel_id = ? AND name = 'Release Notes'").get(ch.id)) {
    hookIns.run(ch.id, 'Release Notes', crypto.randomBytes(32).toString('hex'), null, admin.id);
  }
}

console.log(`Layout: ${LAYOUT.length} channels in ${CATEGORIES.length} categories. Pages: ${pages}, screenshots: ${shots}.`);

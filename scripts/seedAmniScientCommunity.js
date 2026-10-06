'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = process.env.HAVEN_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Haven-AmniScient');
process.env.HAVEN_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const { ENV_PATH } = require('../src/paths');
const { initDatabase } = require('../src/database');
const { MEMBER_PERMS } = require('../src/roleDefaults');

const MARKER = 'amni_scient_community_seed';
const VANITY = 'amni';

const PRODUCTS = [
  'Braid', 'Symphony', 'Grok-Remote', 'Amni-OS', 'Amni-AI', 'Amni-Browse',
  'Amni-Calc', 'Amni-Explore', 'Amni-Space', 'Amni-Weather', 'Amni-Game',
  'Amni-Learn', 'Amni-LLM', 'Amni-Connect', 'Amni-Code', 'Amni-Core',
  'Amni-Haven', 'HedgeDoc', 'Amni-Crypt', 'Amni-Life', 'Amni-Prayer',
  'Amni-Type', 'Amni-Mail'
];

function hexCode() {
  return crypto.randomBytes(4).toString('hex');
}

function ensureEnv() {
  if (fs.existsSync(ENV_PATH)) return;
  const jwt = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(ENV_PATH, [
    'PORT=3010',
    'HOST=127.0.0.1',
    'SERVER_NAME=Amni-Scient',
    `JWT_SECRET=${jwt}`,
    'ADMIN_USERNAME=amnibro',
    'FORCE_HTTP=true',
    'PUBLIC_URL=https://haven.amni-scient.com',
    ''
  ].join('\n'), { encoding: 'utf8' });
  console.log('Wrote', ENV_PATH);
}

function uniqueCode(db) {
  let code = hexCode();
  while (db.prepare('SELECT 1 FROM channels WHERE code = ?').get(code)) code = hexCode();
  return code;
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, value);
}

function addChannel(db, { name, category, topic, isForum, voice, streams, readOnly, welcome, forumTags, position, createdBy }) {
  const existing = db.prepare('SELECT * FROM channels WHERE name = ? AND COALESCE(is_dm, 0) = 0').get(name);
  if (existing) return existing;
  const code = uniqueCode(db);
  const res = db.prepare(`
    INSERT INTO channels (name, code, created_by, topic, is_private, is_forum, voice_enabled, streams_enabled, text_enabled, media_enabled, read_only, show_welcome, category, position, forum_tags)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
  `).run(
    name, code, createdBy, topic || '',
    isForum ? 1 : 0,
    voice ? 1 : 0,
    streams ? 1 : 0,
    readOnly ? 1 : 0,
    welcome ? 1 : 0,
    category,
    position,
    forumTags ? JSON.stringify(forumTags) : null
  );
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(res.lastInsertRowid);
}

function ensurePrereleaseChannel(db, createdBy) {
  const testers = db.prepare("SELECT * FROM channels WHERE name = 'testers' AND COALESCE(is_dm, 0) = 0").get();
  let ch = db.prepare("SELECT * FROM channels WHERE name = 'prerelease' AND COALESCE(is_dm, 0) = 0").get();
  if (!ch) {
    const pos = testers ? testers.position + 1 : 5;
    db.prepare('UPDATE channels SET position = position + 1 WHERE COALESCE(is_dm, 0) = 0 AND position >= ?').run(pos);
    ch = addChannel(db, {
      name: 'prerelease',
      category: 'Testing',
      topic: 'Staff drops APKs, installers, and zips here. Tester role required. Grab it in #introductions.',
      createdBy,
      position: pos
    });
  }
  try {
    db.prepare("UPDATE channels SET notification_type = 'announcement' WHERE id = ?").run(ch.id);
  } catch {}
  return ch;
}

function joinEveryone(db, channelId) {
  const users = db.prepare('SELECT id FROM users').all();
  const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  const txn = db.transaction(() => {
    for (const u of users) ins.run(channelId, u.id);
  });
  txn();
}

function ensureTesterRole(db) {
  let role = db.prepare("SELECT * FROM roles WHERE name = 'Tester' AND scope = 'server'").get();
  if (!role) {
    const res = db.prepare("INSERT INTO roles (name, level, scope, color, auto_assign) VALUES ('Tester', 10, 'server', '#C89B4E', 0)").run();
    const perm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
    MEMBER_PERMS.forEach((p) => perm.run(res.lastInsertRowid, p));
    role = db.prepare('SELECT * FROM roles WHERE id = ?').get(res.lastInsertRowid);
  }
  return role;
}

function postRoleMenu(db, adminId, channel, testerRole) {
  if (!adminId || !channel || !testerRole) return;
  const existing = db.prepare('SELECT 1 FROM role_menus WHERE channel_id = ?').get(channel.id);
  if (existing) return;
  const content = 'Want to test builds? Click the flask. That puts you in #testers and #prerelease so you get pings and the APKs.';
  const msg = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(channel.id, adminId, content);
  db.prepare('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)').run(
    msg.lastInsertRowid,
    channel.id,
    adminId,
    'Tester',
    JSON.stringify({ roles: [{ roleId: testerRole.id, emoji: '🧪' }] })
  );
  db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(msg.lastInsertRowid, adminId, '🧪');
}

ensureEnv();
const db = initDatabase();

const already = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(MARKER);
const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
const createdBy = admin ? admin.id : null;
const tester = ensureTesterRole(db);

let pos = 0;
const nextPos = () => { pos += 1; return pos; };

const general = addChannel(db, {
  name: 'general', category: 'Community', topic: 'Hang out. Product talk goes in the product channels.',
  welcome: true, createdBy, position: nextPos()
});
addChannel(db, {
  name: 'announcements', category: 'Community', topic: 'Staff posts. Chat lives in #general.',
  readOnly: true, createdBy, position: nextPos()
});
const intros = addChannel(db, {
  name: 'introductions', category: 'Community', topic: 'Who you are and what you want to try.',
  createdBy, position: nextPos()
});
addChannel(db, {
  name: 'testers', category: 'Testing', topic: 'People who opted in to try builds. Grab Tester in #introductions.',
  createdBy, position: nextPos()
});
ensurePrereleaseChannel(db, createdBy);
addChannel(db, {
  name: 'bug-reports', category: 'Feedback', topic: 'One bug per topic. Tag the product.',
  isForum: true, createdBy, position: nextPos(),
  forumTags: [
    { name: 'Crash', emoji: '💥' }, { name: 'UI', emoji: '🖼️' }, { name: 'Voice', emoji: '🎙️' },
    { name: 'Install', emoji: '📦' }, { name: 'Other', emoji: '🐛' }
  ]
});
addChannel(db, {
  name: 'feature-requests', category: 'Feedback', topic: 'One request per topic. Tag the product.',
  isForum: true, createdBy, position: nextPos(),
  forumTags: [
    { name: 'Small', emoji: '🔹' }, { name: 'Big', emoji: '🔶' }, { name: 'Nice to have', emoji: '✨' }
  ]
});
addChannel(db, {
  name: 'voice', category: 'Voice', topic: 'Talk. Camera optional.',
  voice: true, createdBy, position: nextPos()
});
addChannel(db, {
  name: 'video', category: 'Voice', topic: 'Camera and screen share.',
  voice: true, streams: true, createdBy, position: nextPos()
});

PRODUCTS.forEach((name) => {
  addChannel(db, {
    name, category: 'Products', topic: `${name} — bugs and requests can also go in the forums.`,
    createdBy, position: nextPos()
  });
});

const testersCh = db.prepare("SELECT * FROM channels WHERE name = 'testers' AND COALESCE(is_dm, 0) = 0").get();
const prereleaseCh = db.prepare("SELECT * FROM channels WHERE name = 'prerelease' AND COALESCE(is_dm, 0) = 0").get();
const testerGate = tester ? JSON.stringify({ mode: 'any', roles: [tester.id] }) : null;
if (testerGate) {
  for (const ch of [testersCh, prereleaseCh]) {
    if (!ch) continue;
    db.prepare('UPDATE channels SET role_gate = ? WHERE id = ?').run(testerGate, ch.id);
    const holders = db.prepare('SELECT user_id FROM user_roles WHERE role_id = ? AND channel_id IS NULL').all(tester.id);
    const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, via_role_gate) VALUES (?, ?, 1)');
    holders.forEach((h) => ins.run(ch.id, h.user_id));
    if (createdBy) db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch.id, createdBy);
  }
}

const publicChannels = db.prepare(`
  SELECT id FROM channels WHERE COALESCE(is_dm, 0) = 0 AND COALESCE(is_private, 0) = 0 AND role_gate IS NULL
`).all();
publicChannels.forEach((ch) => joinEveryone(db, ch.id));

const joinIds = publicChannels.map((c) => c.id);
setSetting(db, 'server_name', 'Amni-Scient');
setSetting(db, 'vanity_code', VANITY);
if (!db.prepare("SELECT value FROM server_settings WHERE key = 'server_code'").get()?.value) {
  setSetting(db, 'server_code', uniqueCode(db));
}
setSetting(db, 'default_join_channels', JSON.stringify(joinIds));
setSetting(db, 'channel_sort_mode', 'manual');
setSetting(db, 'channel_cat_order', JSON.stringify(['Community', 'Testing', 'Feedback', 'Voice', 'Products']));
setSetting(db, 'max_upload_mb', '256');
setSetting(db, 'welcome_message', 'Welcome. Pick Tester in #introductions if you want builds. Prerelease APKs and packages land in #prerelease.');
setSetting(db, 'setup_wizard_complete', 'true');
setSetting(db, 'guests_enabled', 'true');
setSetting(db, 'guest_channels', String(general.id));
setSetting(db, MARKER, 'v1');

postRoleMenu(db, createdBy, intros, tester);

const invite = db.prepare("SELECT value FROM server_settings WHERE key = 'server_code'").get()?.value;
console.log('Data dir:', dataDir);
console.log('Channels:', db.prepare('SELECT COUNT(*) AS n FROM channels WHERE COALESCE(is_dm,0)=0').get().n);
console.log('Vanity join:', VANITY);
console.log('Invite code:', invite);
if (!createdBy) console.log('Register as amnibro, then run this script again to post the Tester menu.');
if (already) console.log('Re-ran seed (idempotent).');

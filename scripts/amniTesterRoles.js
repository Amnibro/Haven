'use strict';
const crypto = require('crypto');
const os = require('os');
const path = require('path');
process.env.HAVEN_DATA_DIR = process.env.HAVEN_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'haven-amniscient');
const { initDatabase } = require('../src/database');
const { MEMBER_PERMS } = require('../src/roleDefaults');
const TAG = 'amni-testing', BETA = 'https://amni-scient.com/beta.html', GROUP = 'https://groups.google.com/g/amni-scient-testers', PLAY = 'https://play.google.com/apps/testing/', TF = 'https://testflight.apple.com/join/';
const APPS = { 'Amni-Chat': { android: `APK on ${BETA} while Play review finishes`, ios: `${TF}PUQxysvc` }, 'Amni-Crypt': { android: `${PLAY}com.amnicrypt` }, 'Amni-Type': { android: `${PLAY}com.amniscient.type`, ios: `${TF}yTvRRNSE` }, 'Amni-Map': { android: `APK on ${BETA} while Play review finishes` }, 'Amni-Learn': { android: `${PLAY}com.amnilearn.mobile`, ios: `${TF}gnWxJTFg` }, ContAIgion: { android: `${PLAY}com.amni.contaigion` }, HumAInity: { android: `${PLAY}com.amni.humainity` } };
const GROUPS = [
  { role: 'Comms Tester', emoji: '💬', color: '#5BA4E6', channel: 'test-comms', title: 'Talk & Privacy', apps: ['Amni-Chat', 'Amni-Crypt'] },
  { role: 'Tools Tester', emoji: '🧭', color: '#6FBF8A', channel: 'test-tools', title: 'Everyday Tools', apps: ['Amni-Type', 'Amni-Map'] },
  { role: 'Learn Tester', emoji: '📚', color: '#E0B45A', channel: 'test-learn', title: 'Learning', apps: ['Amni-Learn'] },
  { role: 'Games Tester', emoji: '🎮', color: '#C27BD8', channel: 'test-games', title: 'Games', apps: ['ContAIgion', 'HumAInity'] }
];
const db = initDatabase();
const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
const role = (name) => db.prepare("SELECT * FROM roles WHERE name = ? AND scope = 'server'").get(name);
const chan = (name) => db.prepare('SELECT * FROM channels WHERE name = ? AND COALESCE(is_dm,0) = 0 AND parent_channel_id IS NULL').get(name);
const tester = role('Tester'), mod = role('Mod'), intros = chan('introductions');
if (!admin || !tester || !mod || !intros) { console.error('Run setup-amni-scient.sh first (needs admin, Tester, Mod, #introductions).'); process.exit(1); }
const hexCode = () => { let c; do { c = crypto.randomBytes(4).toString('hex'); } while (db.prepare('SELECT 1 FROM channels WHERE code = ?').get(c)); return c; };
const appLine = (n) => `- **${n}:** Android ${APPS[n].android}${APPS[n].ios ? ` · iPhone ${APPS[n].ios}` : ''}`;
const gateIns = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, via_role_gate) VALUES (?, ?, 1)');
const sync = (ch, roleIds) => { db.prepare(`SELECT DISTINCT user_id FROM user_roles WHERE channel_id IS NULL AND role_id IN (${roleIds.map(() => '?').join(',')})`).all(...roleIds).forEach((h) => gateIns.run(ch.id, h.user_id)); gateIns.run(ch.id, admin.id); };
db.transaction(() => {
  const roles = GROUPS.map((g, i) => {
    const r = role(g.role) || (db.prepare("INSERT INTO roles (name, level, scope, color, auto_assign) VALUES (?, 10, 'server', ?, 0)").run(g.role, g.color), role(g.role));
    db.prepare('UPDATE roles SET color = ?, max_upload_mb = 256 WHERE id = ?').run(g.color, r.id);
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
    MEMBER_PERMS.forEach((p) => ins.run(r.id, p));
    const gate = [r.id, tester.id, mod.id];
    let ch = chan(g.channel);
    if (!ch) { db.prepare('INSERT INTO channels (name, code, created_by, position) VALUES (?, ?, ?, ?)').run(g.channel, hexCode(), admin.id, 100 + i); ch = chan(g.channel); }
    db.prepare("UPDATE channels SET category = 'Testing', position = ?, topic = ?, role_gate = ?, is_private = 0, read_only = 0, text_enabled = 1, media_enabled = 1 WHERE id = ?").run(100 + i, `${g.title} testing: ${g.apps.join(' and ')}. Links pinned; talk about the builds here.`, JSON.stringify({ mode: 'any', roles: gate }), ch.id);
    sync(ch, gate);
    db.prepare('DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ? AND imported_from = ?)').run(ch.id, TAG);
    db.prepare('DELETE FROM messages WHERE channel_id = ? AND imported_from = ?').run(ch.id, TAG);
    const m = db.prepare("INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username, webhook_avatar, imported_from) VALUES (?, NULL, ?, 1, 'Amni-Scient', '/uploads/amni-icon.png', ?)").run(ch.id, [`# ${g.emoji} ${g.title} testing`, `Test builds of ${g.apps.join(' and ')}. News, questions and first impressions for these apps go here.`, '', '## Join', `1. **Android:** join the testers group with the Google account on your phone: ${GROUP}`, '2. Open each link on your phone and tap *Become a tester*, then install. On iPhone, open the TestFlight link.', '', ...g.apps.map(appLine), '', '## Report', 'One bug per topic in #bug-reports, ideas in #feature-requests. Tag the app.', `Want every app and the raw builds in #prerelease? Take 🧪 Tester in #introductions.`].join('\n'), TAG);
    db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(m.lastInsertRowid, ch.id, admin.id);
    return { roleId: r.id, emoji: g.emoji };
  });
  const all = [tester.id, ...roles.map((r) => r.roleId), mod.id], testers = chan('testers');
  db.prepare('UPDATE channels SET role_gate = ? WHERE id = ?').run(JSON.stringify({ mode: 'any', roles: all }), testers.id);
  sync(testers, all);
  db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run('Say hi. Pick the apps you want to test here.', intros.id);
  const menu = db.prepare('SELECT message_id FROM role_menus WHERE channel_id = ? ORDER BY message_id LIMIT 1').get(intros.id);
  const text = ['**Pick what you want to test.** Each pick opens a channel with the links and news for just those apps, so you can start small.', ...GROUPS.map((g) => `${g.emoji} **${g.title}:** ${g.apps.join(', ')}`), '🧪 **Everything:** every app, plus raw builds in #prerelease', '', 'Change your picks any time by clicking again.'].join('\n');
  const data = JSON.stringify({ roles: [...roles, { roleId: tester.id, emoji: '🧪' }] });
  menu ? (db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(text, menu.message_id), db.prepare("UPDATE role_menus SET title = 'Testing', data = ? WHERE message_id = ?").run(data, menu.message_id)) : db.prepare('INSERT INTO role_menus (message_id, channel_id, created_by, title, data) VALUES (?, ?, ?, ?, ?)').run(db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(intros.id, admin.id, text).lastInsertRowid, intros.id, admin.id, 'Testing', data);
  const welcome = db.prepare("SELECT m.id, m.content FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.name = 'welcome' AND m.imported_from = 'amni-page' AND m.content LIKE '%**Testing:**%'").get();
  welcome && db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(welcome.content.replace(/- \*\*Testing:\*\*.*/, '- **Testing:** pick what you want to test in #introductions: 💬 Talk & Privacy, 🧭 Everyday Tools, 📚 Learning, 🎮 Games, or 🧪 everything.'), welcome.id);
})();
console.log(`Tester roles: ${GROUPS.map((g) => `${g.emoji} ${g.role} -> #${g.channel}`).join(', ')}`);

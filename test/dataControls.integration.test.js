'use strict';

// Data controls end to end against a real server: deleting your messages
// older than N days, Auto-delete my messages, Export my data, blocking, and
// how the session list names the Android and iOS apps.
//
//   node --test test/dataControls.integration.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'correct horse 1';

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

let server;
let base;
let dataDir;
let fx;
const sockets = [];
const openDb = () => new Database(path.join(dataDir, 'haven.db'));
const sql = (query, ...params) => { const db = openDb(); try { return db.prepare(query).run(...params); } finally { db.close(); } };
const get = (query, ...params) => { const db = openDb(); try { return db.prepare(query).get(...params); } finally { db.close(); } };
const all = (query, ...params) => { const db = openDb(); try { return db.prepare(query).all(...params); } finally { db.close(); } };

// A socket that remembers every event, so a test can wait for one that may
// already have arrived.
function connect(token, headers) {
  const s = io(base, { auth: { token }, transports: ['websocket'], forceNew: true, extraHeaders: headers });
  sockets.push(s);
  const seen = [];
  s.onAny((event, payload) => seen.push({ event, payload }));
  s.waitFor = (event, pred = () => true, ms = 4000) => {
    const hit = seen.find(e => e.event === event && pred(e.payload));
    if (hit) return Promise.resolve(hit.payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.offAny(on); reject(new Error(`timed out waiting for ${event}`)); }, ms);
      const on = (ev, payload) => { if (ev === event && pred(payload)) { clearTimeout(timer); s.offAny(on); resolve(payload); } };
      s.onAny(on);
    });
  };
  s.mark = () => seen.length;
  s.since = (mark, event) => seen.slice(mark).filter(e => e.event === event).map(e => e.payload);
  s.ask = (event, payload) => new Promise(resolve => s.emit(event, payload, resolve));
  return new Promise((resolve, reject) => {
    s.on('connect_error', reject);
    s.once('session-info', () => resolve(s));
  });
}
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-data-controls-int-'));
  const port = await availablePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET: 'd'.repeat(64), PORT: String(port), ADMIN_USERNAME: 'tester' };
  const seed = spawnSync(process.execPath, ['-e', `
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcryptjs');
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const hash = bcrypt.hashSync(${JSON.stringify(PASSWORD)}, 4);
    const addUser = (name, extra = '') => db.prepare("INSERT INTO users (username, password_hash, display_name, created_at, public_key, signing_key" + (extra ? ', is_guest' : '') + ") VALUES (?, ?, ?, '2020-01-01 00:00:00', '{}', '{}'" + (extra ? ', 1' : '') + ")").run(name, hash, name[0].toUpperCase() + name.slice(1)).lastInsertRowid;
    const ids = { alice: addUser('alice'), bob: addUser('bob'), carol: addUser('carol'), dave: addUser('dave'), guest: addUser('visitor', 'guest') };
    const chan = (name, code, dm, group) => db.prepare('INSERT INTO channels (name, code, created_by, is_dm, is_group) VALUES (?, ?, ?, ?, ?)').run(name, code, ids.alice, dm, group).lastInsertRowid;
    const ch = { general: chan('general', 'aaaa0001', 0, 0), dm: chan('DM', 'aaaa0002', 1, 0), group: chan('Group DM', 'aaaa0003', 1, 1), left: chan('secret', 'aaaa0004', 0, 0), dm2: chan('DM', 'aaaa0005', 1, 0) };
    const member = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
    for (const u of ['alice', 'bob', 'carol', 'dave']) member.run(ch.general, ids[u]);
    member.run(ch.dm, ids.alice); member.run(ch.dm, ids.bob);
    member.run(ch.group, ids.alice); member.run(ch.group, ids.dave);
    member.run(ch.dm2, ids.dave); member.run(ch.dm2, ids.carol);
    const msg = db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at, is_archived, edited_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const ago = (d) => db.prepare("SELECT datetime('now', ?) AS t").get('-' + d + ' days').t;
    const m = {
      aliceOld: msg.run(ch.general, ids.alice, 'alice old', ago(40), 0, null, null).lastInsertRowid,
      aliceProtected: msg.run(ch.general, ids.alice, 'alice protected', ago(60), 1, null, null).lastInsertRowid,
      aliceRecent: msg.run(ch.general, ids.alice, 'alice recent', ago(1), 0, ago(1), null).lastInsertRowid,
      aliceDm: msg.run(ch.dm, ids.alice, '{"v":2,"iv":"aaa","ct":"bbb"}', ago(3), 0, null, null).lastInsertRowid,
      aliceLeft: msg.run(ch.left, ids.alice, 'in a channel alice left', ago(5), 0, null, null).lastInsertRowid,
      bobOld: msg.run(ch.general, ids.bob, 'bob old', ago(40), 0, null, null).lastInsertRowid,
      daveOld: msg.run(ch.general, ids.dave, 'dave old', ago(10), 0, null, null).lastInsertRowid,
      daveNew: msg.run(ch.general, ids.dave, 'dave new', ago(0), 0, null, null).lastInsertRowid,
    };
    db.prepare('UPDATE messages SET reply_to = ? WHERE id = ?').run(m.aliceOld, m.aliceRecent);
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('allow_self_purge', 'true')").run();
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_name', 'Test Haven')").run();
    db.prepare('INSERT INTO user_nicknames (owner_id, target_id, nickname) VALUES (?, ?, ?)').run(ids.alice, ids.bob, 'Bobby');
    const tokens = {};
    for (const [name, id] of Object.entries(ids)) tokens[name] = jwt.sign({ id, username: name, displayName: name, pwv: 1, ...(name === 'guest' && { isGuest: true }) }, process.env.JWT_SECRET);
    process.stdout.write(JSON.stringify({ ids, ch, m, tokens }));
  `], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  fx = JSON.parse(seed.stdout.slice(seed.stdout.lastIndexOf('{"ids"')));

  let output = '';
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { output += d; });
  server.stderr.on('data', d => { output += d; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited:\n${output}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
    await settle(150);
  }
  throw new Error(`server did not start:\n${output}`);
});

test.after(async () => {
  for (const s of sockets) s.close();
  server?.kill();
  await settle(200);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('deleting messages older than 30 days keeps newer and protected ones and tells clients the cutoff', async () => {
  const alice = await connect(fx.tokens.alice);
  const watcher = await connect(fx.tokens.carol);
  watcher.emit('join-channel', { code: 'aaaa0001' });
  await watcher.waitFor('channel-joined', p => p && p.code === 'aaaa0001').catch(() => settle(300));

  assert.deepEqual(await alice.ask('self-purge-messages', { password: PASSWORD, olderThanDays: 1.5 }), { error: 'olderThanDays must be a whole number of days from 1 to 3650' });
  assert.deepEqual(await alice.ask('self-purge-messages', { password: 'wrong', olderThanDays: 30 }), { error: 'Incorrect password' });

  const res = await alice.ask('self-purge-messages', { password: PASSWORD, olderThanDays: 30 });
  assert.equal(res.success, true);
  assert.equal(res.deleted, 1);
  assert.equal(res.kept, 1);
  assert.match(res.before, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const event = await watcher.waitFor('messages-purged', p => p.channelCode === 'aaaa0001' && p.userId === fx.ids.alice);
  assert.deepEqual(event, { channelCode: 'aaaa0001', userId: fx.ids.alice, before: res.before });
  assert.equal(get('SELECT 1 AS x FROM messages WHERE id = ?', fx.m.aliceOld), undefined);
  assert.ok(get('SELECT 1 AS x FROM messages WHERE id = ?', fx.m.aliceRecent));
  assert.ok(get('SELECT 1 AS x FROM messages WHERE id = ?', fx.m.aliceProtected));
  assert.ok(get('SELECT 1 AS x FROM messages WHERE id = ?', fx.m.bobOld), 'only her own messages');
  const audit = get("SELECT details FROM audit_log WHERE action = 'self_purge_messages' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(audit.details), { deleted: 1, kept: 1, channels: 1, days: 30 });
});

test('auto-delete: read, set with a password, first run, and the self-purge gate', async () => {
  const dave = await connect(fx.tokens.dave);
  const dave2 = await connect(fx.tokens.dave);
  assert.deepEqual(await dave.ask('get-data-controls', {}), { allowSelfPurge: true, autoDeleteDays: 0, isGuest: false });
  assert.deepEqual(await dave.ask('set-auto-delete-messages', { days: 5, password: PASSWORD }), { error: 'Pick Off, 1 day, 7 days, 30 days, 90 days or 1 year' });
  assert.deepEqual(await dave.ask('set-auto-delete-messages', { days: 7 }), { error: 'Password is required' });
  assert.deepEqual(await dave.ask('set-auto-delete-messages', { days: 7, password: 'nope' }), { error: 'Incorrect password' });
  dave.emit('join-channel', { code: 'aaaa0001' });
  await settle(300);

  assert.deepEqual(await dave.ask('set-auto-delete-messages', { days: 7, password: PASSWORD }), { success: true, autoDeleteDays: 7 });
  assert.deepEqual(await dave2.waitFor('data-controls-updated'), { autoDeleteDays: 7 }, 'every one of his sockets hears');
  const purged = await dave.waitFor('messages-purged', p => p.userId === fx.ids.dave);
  assert.ok(purged.before, 'the first run happens straight away, with a cutoff');
  assert.equal(get('SELECT 1 AS x FROM messages WHERE id = ?', fx.m.daveOld), undefined);
  assert.ok(get('SELECT 1 AS x FROM messages WHERE id = ?', fx.m.daveNew));
  const audit = get("SELECT target_id, details FROM audit_log WHERE action = 'auto_delete_messages' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.target_id, fx.ids.dave);
  assert.deepEqual(JSON.parse(audit.details), { deleted: 1, kept: 0, channels: 1, days: 7 });
  assert.equal((await dave.ask('get-data-controls', {})).autoDeleteDays, 7);

  sql("UPDATE server_settings SET value = 'false' WHERE key = 'allow_self_purge'");
  assert.deepEqual(await dave.ask('set-auto-delete-messages', { days: 30, password: PASSWORD }), { error: 'This server does not allow deleting your messages automatically' });
  assert.equal((await dave.ask('get-data-controls', {})).allowSelfPurge, false);
  assert.deepEqual(await dave.ask('set-auto-delete-messages', { days: 0 }), { success: true, autoDeleteDays: 0 }, 'turning it off is always allowed');
  assert.deepEqual(await dave.ask('self-purge-messages', { password: PASSWORD, olderThanDays: 1 }), { error: 'This server does not allow deleting all your messages at once' });
  sql("UPDATE server_settings SET value = 'true' WHERE key = 'allow_self_purge'");
});

test('export: Bearer only, own messages only, guests refused, three an hour', async () => {
  assert.equal((await fetch(`${base}/api/me/export`)).status, 401);
  assert.equal((await fetch(`${base}/api/me/export`, { headers: { Authorization: 'Bearer nonsense' } })).status, 401);
  const guest = await fetch(`${base}/api/me/export`, { headers: { Authorization: `Bearer ${fx.tokens.guest}` } });
  assert.equal(guest.status, 403);
  assert.ok((await guest.json()).error);

  sql('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', fx.ids.carol, fx.ids.dave);
  const auth = { headers: { Authorization: `Bearer ${fx.tokens.alice}` } };
  const res = await fetch(`${base}/api/me/export`, auth);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="haven-export-alice-\d{4}-\d\d-\d\d\.json"$/);
  const doc = await res.json();
  assert.equal(doc.format, 'haven-export');
  assert.equal(doc.version, 1);
  assert.ok(!Number.isNaN(Date.parse(doc.exportedAt)));
  assert.deepEqual(doc.server, { name: 'Test Haven' });
  assert.equal(doc.user.id, fx.ids.alice);
  assert.equal(doc.user.username, 'alice');
  assert.equal(doc.user.displayName, 'Alice');
  assert.equal(doc.user.createdAt, '2020-01-01T00:00:00Z');
  assert.deepEqual(doc.settings, { autoDeleteDays: 0, nicknames: { [fx.ids.bob]: 'Bobby' } });
  const byCode = Object.fromEntries(doc.channels.map(c => [c.code, c]));
  assert.deepEqual(byCode.aaaa0001, { code: 'aaaa0001', name: 'general', type: 'channel' });
  assert.deepEqual(byCode.aaaa0002, { code: 'aaaa0002', name: 'Bob', type: 'dm' });
  assert.deepEqual(byCode.aaaa0003, { code: 'aaaa0003', name: 'Group DM', type: 'group' });
  assert.equal(byCode.aaaa0004, undefined, 'a channel she left is not listed by its real code');
  assert.deepEqual(byCode[`former-${fx.ch.left}`], { code: `former-${fx.ch.left}`, name: 'secret', type: 'channel' });

  const ids = doc.messages.map(m => m.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [fx.m.aliceProtected, fx.m.aliceRecent, fx.m.aliceDm, fx.m.aliceLeft].sort((a, b) => a - b), 'all of hers and nobody else\'s');
  const dmMsg = doc.messages.find(m => m.id === fx.m.aliceDm);
  assert.deepEqual(dmMsg, { id: fx.m.aliceDm, channel: 'aaaa0002', createdAt: dmMsg.createdAt, content: '{"v":2,"iv":"aaa","ct":"bbb"}', encrypted: true });
  const recent = doc.messages.find(m => m.id === fx.m.aliceRecent);
  assert.equal(recent.encrypted, false);
  assert.ok(recent.editedAt && recent.createdAt.endsWith('Z'));
  assert.equal(recent.replyTo, undefined, 'the reply target was deleted, so reply_to is gone');
  assert.deepEqual(doc.blockedUsers, []);

  const carol = await (await fetch(`${base}/api/me/export`, { headers: { Authorization: `Bearer ${fx.tokens.carol}` } })).json();
  assert.deepEqual(carol.blockedUsers, [{ id: fx.ids.dave, username: 'dave' }]);
  assert.deepEqual(carol.messages, []);
  sql('DELETE FROM user_blocks WHERE blocker_id = ?', fx.ids.carol);

  assert.equal((await fetch(`${base}/api/me/export`, auth)).status, 200);
  assert.equal((await fetch(`${base}/api/me/export`, auth)).status, 200);
  const limited = await fetch(`${base}/api/me/export`, auth);
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /3 times an hour/);
});

test('blocking: events, session-info, DMs both ways, new DMs, groups, calls and unread', async () => {
  const alice = await connect(fx.tokens.alice);
  const alice2 = await connect(fx.tokens.alice);
  const bob = await connect(fx.tokens.bob);

  assert.deepEqual(await alice.ask('block-user', { userId: fx.ids.alice }), { error: 'You can\'t block yourself' });
  assert.deepEqual(await alice.ask('block-user', { userId: 99999 }), { error: 'User not found' });
  assert.deepEqual(await alice.ask('block-user', { userId: fx.ids.bob }), { success: true, blockedIds: [fx.ids.bob] });
  assert.deepEqual(await alice2.waitFor('blocked-users-updated'), { blockedIds: [fx.ids.bob] });
  assert.deepEqual(await alice.ask('block-user', { userId: fx.ids.bob }), { success: true, blockedIds: [fx.ids.bob] }, 'blocking twice is fine');
  assert.deepEqual(await alice.ask('get-blocked-users', {}), { users: [{ id: fx.ids.bob, username: 'bob', displayName: 'Bob', avatar: null }] });
  const fresh = await connect(fx.tokens.alice);
  assert.ok(fresh);
  const info = await fresh.waitFor('session-info');
  assert.deepEqual(info.blockedUserIds, [fx.ids.bob]);

  const before = get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', fx.ch.dm).n;
  let mark = bob.mark();
  bob.emit('send-message', { code: 'aaaa0002', content: 'hello?' });
  assert.equal(await bob.waitFor('error-msg', p => p === 'You can\'t send messages to this person.', 3000), 'You can\'t send messages to this person.');
  alice.emit('send-message', { code: 'aaaa0002', content: 'and me' });
  await alice.waitFor('error-msg', p => p === 'You can\'t send messages to this person.', 3000);
  assert.equal(get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', fx.ch.dm).n, before, 'nothing was stored');
  alice.emit('edit-message', { messageId: fx.m.aliceDm, channelCode: 'aaaa0002', content: 'edited' });
  await settle(300);
  assert.equal(get('SELECT content FROM messages WHERE id = ?', fx.m.aliceDm).content, '{"v":2,"iv":"aaa","ct":"bbb"}', 'edits are refused too');

  bob.emit('voice-join', { code: 'aaaa0002' });
  assert.equal(await bob.waitFor('error-msg', p => p === 'You can\'t call this person.', 3000), 'You can\'t call this person.');

  // Carol blocks Alice: Alice can neither start a DM with her nor put her in a group.
  const carol = await connect(fx.tokens.carol);
  await carol.ask('block-user', { userId: fx.ids.alice });
  alice.emit('start-dm', { targetUserId: fx.ids.carol });
  await alice.waitFor('error-msg', p => p === 'You can\'t send messages to this person.', 3000);
  alice.emit('start-group-dm', { userIds: [fx.ids.bob, fx.ids.carol] });
  await alice.waitFor('error-msg', p => p === 'This person can\'t be added.', 3000);
  alice.emit('invite-group-dm', { code: 'aaaa0003', userIds: [fx.ids.carol] });
  await alice.waitFor('error-msg', p => p === 'This person can\'t be added.', 3000);
  assert.equal(get('SELECT COUNT(*) AS n FROM dm_group_invites WHERE user_id = ?', fx.ids.carol).n, 0);
  mark = carol.mark();
  carol.emit('start-dm', { targetUserId: fx.ids.alice });
  await carol.waitFor('error-msg', p => p === 'You can\'t send messages to this person.', 3000);
  assert.equal(carol.since(mark, 'dm-opened').length, 0, 'the blocker cannot start one either');

  // Bob's channel messages still reach Alice, but do not count as unread.
  bob.emit('join-channel', { code: 'aaaa0001' });
  await settle(200);
  bob.emit('send-message', { code: 'aaaa0001', content: 'bob in general' });
  await settle(400);
  assert.ok(get("SELECT 1 AS x FROM messages WHERE content = 'bob in general'"), 'channel delivery is unchanged');
  mark = alice.mark();
  alice.emit('get-channels');
  const list = await alice.waitFor('channels-list');
  const general = list.find(c => c.code === 'aaaa0001');
  assert.ok(general.latestMessageId > 0);
  const unreadFromBob = all('SELECT id FROM messages WHERE channel_id = ? AND user_id = ? AND id > COALESCE((SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?), 0)', fx.ch.general, fx.ids.bob, fx.ids.alice, fx.ch.general).length;
  assert.ok(unreadFromBob > 0, 'there is something of Bob\'s she has not read');
  const others = all("SELECT id FROM messages WHERE channel_id = ? AND user_id NOT IN (?, ?) AND thread_id IS NULL AND id > COALESCE((SELECT last_read_message_id FROM read_positions WHERE user_id = ? AND channel_id = ?), 0)", fx.ch.general, fx.ids.alice, fx.ids.bob, fx.ids.alice, fx.ch.general).length;
  assert.equal(general.unreadCount, others, 'yet only other people\'s messages count as unread');

  // Unblocking lets the DM work again.
  assert.deepEqual(await alice.ask('unblock-user', { userId: fx.ids.bob }), { success: true, blockedIds: [] });
  assert.deepEqual(await alice2.waitFor('blocked-users-updated', p => p.blockedIds.length === 0), { blockedIds: [] });
  bob.emit('join-channel', { code: 'aaaa0002' });
  await settle(200);
  bob.emit('send-message', { code: 'aaaa0002', content: 'hello again' });
  await settle(400);
  assert.equal(get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', fx.ch.dm).n, before + 1);
  await carol.ask('unblock-user', { userId: fx.ids.alice });
});

test('the session list names the Android and iOS apps by model', async () => {
  const android = await connect(fx.tokens.dave, { 'user-agent': 'Haven-Android/6.7.0 (Android 15; Pixel 9 Pro)' });
  await connect(fx.tokens.dave, { 'user-agent': 'Haven-iOS/8.3.0 (iOS 18.1; iPhone16,2)' });
  await connect(fx.tokens.dave, { 'user-agent': 'Haven-Android/6.7.0' });
  android.emit('get-sessions');
  const { sessions } = await android.waitFor('sessions-list');
  const devices = sessions.map(s => s.device);
  assert.ok(devices.includes('Haven for Android · Pixel 9 Pro'), devices.join(' | '));
  assert.ok(devices.includes('Haven for iOS · iPhone16,2'), devices.join(' | '));
  assert.ok(devices.includes('Haven for Android'), devices.join(' | '));
  assert.equal(sessions.find(s => s.current).device, 'Haven for Android · Pixel 9 Pro');
});

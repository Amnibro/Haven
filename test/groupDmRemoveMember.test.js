/**
 * The person who started a group DM can remove people from it (#5740).
 *
 * Only the creator can, and not themselves (they use Leave group). Removing
 * works like a moderator's kick: the removed person loses the group at once
 * and the members still in it are told, so they replace the key. Once the
 * creator has removed everyone, leaving as the last member deletes the group.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/groupDmRemoveMember.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');

const PORT = 3405;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-group-remove-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) =>
  post('/api/auth/register', { username, password: 'grouptest123', eulaVersion: '2.0', ageVerified: true });
const clients = [];
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
const readDb = (sql, ...args) => {
  const db = new Database(path.join(DATA, 'haven.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const jwk = (x) => ({ kty: 'EC', crv: 'P-256', x, y: `y${x}` });
const epochFor = (users) => ({
  keys: users.map((u) => ({ recipientId: u.user.id, wrappedKey: JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: `w${u.user.id}` }) })),
  sig: 'c2lnbmVk',
  roster: users.map((u) => ({ id: u.user.id, ecdhJwk: jwk(`e${u.user.id}`), signJwk: jwk(`s${u.user.id}`) })),
});

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});
test.after(async () => {
  clients.forEach((s) => s.close());
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

const users = {};
const socks = {};

async function makeGroup(creator, joiners) {
  const opened = next(socks[creator], 'group-dm-opened');
  socks[creator].emit('start-group-dm', { userIds: joiners.map((n) => users[n].user.id), name: `G-${creator}-${joiners.join('')}` });
  const { code } = await opened;
  for (const n of joiners) {
    const joined = next(socks[n], 'group-dm-opened', (d) => d.code === code);
    socks[n].emit('accept-group-dm', { code });
    assert.ok(await joined, `${n} joined`);
  }
  const published = next(socks[creator], 'group-epoch-published', (d) => d.code === code);
  socks[creator].emit('publish-group-epoch', { code, epoch: 1, ...epochFor([creator, ...joiners].map((n) => users[n])) });
  assert.ok(await published, 'first key published');
  return code;
}
const membersOf = (code) => readDb('SELECT cm.user_id FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.code = ? ORDER BY cm.user_id', code)
  .map((r) => r.user_id);
const ids = (...names) => names.map((n) => users[n].user.id).sort((a, b) => a - b);

test('setup', async () => {
  for (const n of ['admin', 'bob', 'carol', 'dave', 'erin']) {
    users[n] = await register(n);
    socks[n] = await connect(users[n].token);
    socks[n].emit('publish-public-key', { jwk: jwk(n) });
    socks[n].emit('publish-signing-key', { jwk: jwk(`s${n}`) });
  }
  await wait(600);
});

test('only the creator can remove people, and not themselves', async () => {
  const code = await makeGroup('bob', ['admin', 'carol', 'dave']);
  const tries = [
    ['carol', users.dave.user.id, /Only the person who started/, 'another member'],
    ['admin', users.dave.user.id, /Only the person who started/, 'the server admin, who kicks instead'],
    ['erin', users.dave.user.id, /Group not found/, 'someone outside the group'],
    ['bob', users.bob.user.id, /Leave group/, 'the creator, on themselves'],
    ['bob', users.erin.user.id, /not in this group/, 'someone who is not in it'],
  ];
  for (const [who, target, msg, label] of tries) {
    const refused = next(socks[who], 'error-msg', (m) => msg.test(m));
    socks[who].emit('remove-group-member', { code, userId: target });
    assert.ok(await refused, `refused: ${label}`);
  }
  assert.deepStrictEqual(membersOf(code), ids('admin', 'bob', 'carol', 'dave'), 'nobody was removed');

  // A 1:1 DM is not a group, so there is nobody to remove there.
  const opened = next(socks.bob, 'dm-opened');
  socks.bob.emit('start-dm', { targetUserId: users.carol.user.id });
  const dm = await opened;
  const refused = next(socks.bob, 'error-msg', (m) => /Group not found/.test(m));
  socks.bob.emit('remove-group-member', { code: dm.code, userId: users.carol.user.id });
  assert.ok(await refused, 'refused in a 1:1 DM');
  assert.strictEqual(membersOf(dm.code).length, 2);
});

test('the creator removes someone: they lose the group, the rest are told and replace the key', async () => {
  const code = await makeGroup('bob', ['carol', 'dave']);
  const kicked = next(socks.dave, 'kicked', (d) => d && d.channelCode === code);
  const deleted = next(socks.dave, 'channel-deleted', (d) => d && d.code === code);
  const told = next(socks.carol, 'group-dm-member-left', (d) => d && d.code === code);
  const done = next(socks.bob, 'group-dm-member-removed', (d) => d && d.code === code);
  socks.bob.emit('remove-group-member', { code, userId: users.dave.user.id });

  const k = await kicked;
  assert.ok(k && k.group === true, 'dave hears he was removed from the group');
  assert.ok(await deleted, 'the group is gone from his app right away');
  const left = await told;
  assert.ok(left, 'the members still in it are told');
  assert.strictEqual(left.user.id, users.dave.user.id);
  assert.deepStrictEqual(left.members.map((m) => m.id).sort((a, b) => a - b), ids('bob', 'carol'));
  const ack = await done;
  assert.strictEqual(ack.user.id, users.dave.user.id, 'the creator hears it is done');
  assert.deepStrictEqual(membersOf(code), ids('bob', 'carol'));

  const keys = next(socks.carol, 'group-keys', (d) => d && d.code === code);
  socks.carol.emit('get-group-keys', { code, sinceEpoch: 0 });
  assert.strictEqual((await keys).needsRotation, true, 'the key dave holds must be replaced');
  const refused = next(socks.dave, 'error-msg');
  socks.dave.emit('get-group-keys', { code, sinceEpoch: 0 });
  assert.ok(await refused, 'dave can no longer read the group keys');

  // Emptied by its creator, the group is deleted when they leave it last.
  const carolOut = next(socks.carol, 'channel-deleted', (d) => d && d.code === code);
  socks.bob.emit('remove-group-member', { code, userId: users.carol.user.id });
  assert.ok(await carolOut);
  assert.deepStrictEqual(membersOf(code), ids('bob'));
  const gone = next(socks.bob, 'group-dm-left', (d) => d && d.code === code);
  socks.bob.emit('leave-group-dm', { code, attachments: [] });
  assert.ok(await gone);
  assert.strictEqual(readDb('SELECT 1 FROM channels WHERE code = ?', code).length, 0, 'the group is deleted');
});

// The member menu offers "Remove from group" to the creator only.
test('the member menu offers Remove from group only to the creator, for people in the group', async () => {
  const vm = require('node:vm');
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  const t = (key, vars = {}) => String(key.split('.').reduce((o, k) => (o ? o[k] : undefined), en) || key)
    .replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-groups.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, t, console, setTimeout, clearTimeout });
  vm.runInContext(src.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-groups.js' });
  const make = (me, { confirmed = true } = {}) => {
    const emitted = [];
    const app = {
      ...context.module.exports,
      user: { id: me },
      currentChannel: 'cccccccc',
      channels: [{ code: 'cccccccc', name: 'Crew', is_dm: 1, is_group: 1, created_by: 1, group_members: [{ id: 1 }, { id: 2 }] }],
      _getNickname: (id, name) => name,
      _hideUserContextMenu() {},
      _showConfirmModal: async () => confirmed,
      socket: { emit: (ev, data) => emitted.push([ev, data]) },
    };
    const items = [];
    app._addGroupMemberActions(2, 'bob', (label, onClick) => items.push({ label, onClick }), () => {});
    return { app, emitted, items };
  };
  const creator = make(1);
  assert.strictEqual(creator.items.length, 1);
  assert.match(creator.items[0].label, new RegExp(en.groups.remove_member));
  creator.items[0].onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(creator.emitted)), [['remove-group-member', { code: 'cccccccc', userId: 2 }]]);
  assert.strictEqual(make(2).items.length, 0, 'not offered to another member');
  const selfItems = [];
  creator.app._addGroupMemberActions(1, 'me', (label, onClick) => selfItems.push({ label, onClick }), () => {});
  assert.strictEqual(selfItems.length, 0, 'not offered on yourself');
  const outsider = [];
  creator.app._addGroupMemberActions(3, 'erin', (label, onClick) => outsider.push({ label, onClick }), () => {});
  assert.strictEqual(outsider.length, 0, 'not offered for someone outside the group');
  const cancelled = make(1, { confirmed: false });
  cancelled.items[0].onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(cancelled.emitted, [], 'nothing is sent without confirming');
  for (const key of ['remove_member', 'remove_confirm', 'member_removed']) assert.ok(en.groups[key], key);
});

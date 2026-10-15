'use strict';

// Discord lists private channels to the Ferry bot but keeps them closed until
// its role is added to them. The import picker marks those channels, and a
// fetch that includes one anyway skips it by name instead of importing an
// empty channel or failing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-importaccess-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : null);

// Ferry itself is not needed, only the headers it hands the import.
const ferryPath = require.resolve('../src/ferry');
require.cache[ferryPath] = { id: ferryPath, filename: ferryPath, loaded: true, exports: { importHeaders: () => ({ Authorization: 'Bot test' }) } };
const registerImport = require('../src/routes/import');

const routes = {};
const app = {
  post: (p, ...fns) => { routes['POST ' + p] = fns[fns.length - 1]; },
  get: (p, ...fns) => { routes['GET ' + p] = fns[fns.length - 1]; },
};
registerImport({ app, uploadDiskGuard: (q, s, n) => n(), uploadLimiter: (q, s, n) => n(), importUpload: {}, verifyAdminFromDb: () => true });

const call = (key, req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  routes[key](req, res);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GUILD = '910000000000000001';
const BOT = '910000000000000002';
const BOT_ROLE = '910000000000000003';
const GENERAL = '910000000000000010';
const SECRET = '910000000000000011';
const OPENED = '910000000000000012';
const STAFF_CAT = '910000000000000020';
const SECRET_THREAD = '910000000000000030';
const VIEW = 1024, HISTORY = 65536;
const everyoneDeny = { id: GUILD, type: 0, allow: '0', deny: String(VIEW) };

const discord = {
  [`/users/@me`]: { id: BOT, username: 'Ferry' },
  [`/guilds/${GUILD}`]: {
    id: GUILD, owner_id: '910000000000000099',
    roles: [
      { id: GUILD, name: '@everyone', permissions: String(VIEW + HISTORY) },
      { id: BOT_ROLE, name: 'Ferry', permissions: String(VIEW + HISTORY + 2048 + 536870912) },
    ],
  },
  [`/guilds/${GUILD}/members/${BOT}`]: { roles: [BOT_ROLE] },
  [`/guilds/${GUILD}/channels`]: [
    { id: STAFF_CAT, type: 4, name: 'Staff', position: 0, permission_overwrites: [everyoneDeny] },
    { id: GENERAL, type: 0, name: 'general', position: 1, permission_overwrites: [] },
    // Private, and the bot's role was never added.
    { id: SECRET, type: 0, name: 'secret', position: 2, parent_id: STAFF_CAT, permission_overwrites: [everyoneDeny] },
    // Private too, but the bot's role was added with the two permissions.
    { id: OPENED, type: 0, name: 'opened', position: 3, parent_id: STAFF_CAT,
      permission_overwrites: [everyoneDeny, { id: BOT_ROLE, type: 0, allow: String(VIEW + HISTORY), deny: '0' }] },
  ],
  [`/guilds/${GUILD}/threads/active`]: { threads: [{ id: SECRET_THREAD, name: 'secret plans', parent_id: SECRET }] },
};

const requested = [];
global.fetch = async (url) => {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api\/v10/, '');
  requested.push(p);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (p in discord) return json(discord[p]);
  if (/\/threads\/archived\/public$/.test(p)) return json({ threads: [], has_more: false });
  if (p === `/channels/${GENERAL}/messages` || p === `/channels/${OPENED}/messages`) {
    return json([{ id: '1', type: 0, content: 'hello', timestamp: new Date(2026, 0, 1).toISOString(), author: { id: '5', username: 'a' } }]);
  }
  if (/\/messages$/.test(p)) return json({ message: 'Missing Access' }, 403);
  return json({ message: 'Unknown' }, 404);
};

test('the picker marks a private channel, and its threads, as unreadable', async () => {
  const r = await call('POST /api/import/discord/guild-channels', {
    headers: { authorization: 'Bearer admin' }, body: { useFerry: true, guildId: GUILD },
  });
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.body.channels.map(c => [c.name, c]));
  assert.equal(byName.general.readable, true);
  assert.equal(byName.secret.readable, false);
  assert.equal(byName.opened.readable, true, 'adding the bot role opens it');
  assert.equal(r.body.threads.find(t => t.id === SECRET_THREAD).readable, false);
  assert.ok(!requested.includes(`/channels/${SECRET}/threads/archived/public`), 'no thread lookups for a channel the bot cannot read');
  assert.ok(!JSON.stringify(r.body).includes('Bot test'), 'the token never reaches the client');
});

test('a hidden channel picked anyway is skipped by name, the rest import', async () => {
  requested.length = 0;
  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: {
      useFerry: true, guildId: GUILD, guildName: 'Guild',
      channels: [
        { id: GENERAL, name: 'general' },
        { id: SECRET, name: 'secret' },
        { id: SECRET_THREAD, name: 'secret plans', kind: 'thread', parentId: SECRET },
        { id: OPENED, name: 'opened' },
      ],
    },
  });
  assert.equal(started.status, 202);
  let done = null;
  for (let i = 0; i < 50 && !done; i++) {
    await sleep(100);
    const r = await call('GET /api/import/discord/fetch/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
    if (r.body.state === 'done') done = r;
  }
  assert.ok(done, 'the job finishes');
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.skipped.sort(), ['secret', 'secret plans']);
  assert.deepEqual(done.body.channels.map(c => c.name).sort(), ['general', 'opened']);
  assert.ok(!requested.includes(`/channels/${SECRET}/messages`), 'a hidden channel is never read');
  fs.rmSync(path.join(os.tmpdir(), `haven-import-${done.body.importId}.json`), { force: true });
});

test('when every pick is hidden the error says what to do in Discord', async () => {
  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: { useFerry: true, guildId: GUILD, channels: [{ id: SECRET, name: 'secret' }] },
  });
  let done = null;
  for (let i = 0; i < 50 && !done; i++) {
    await sleep(100);
    const r = await call('GET /api/import/discord/fetch/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
    if (r.body.state === 'done') done = r;
  }
  assert.equal(done.status, 400);
  assert.match(done.body.error, /add the bot's role/);
});

test.after(() => {
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  setImmediate(() => process.exit(0));
});

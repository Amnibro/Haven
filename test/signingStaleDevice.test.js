'use strict';

// A phone left with an old encryption key (an old install, or a key reset
// made elsewhere) cannot open the account's signing key backup. Apps up to
// 8.6.3 answered that by making a new signing key and forcing it in, which
// replaced the account's signing key for every device: messages from the
// account's other devices then showed as unverifiable, or as "keys changed".
// The server now keeps the pinned key for a while after such a device shows
// up, unless a client proves it holds the current key or the keys are reset;
// healthy devices and explicit key resets work as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3441;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-signing-stale-${Date.now()}`);
let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
  (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'stalekey123', eulaVersion: '1.0', ageVerified: true });
const open = [];
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  open.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, events, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { cleanup(); res({ event: null, data: null }); }, ms);
    const handlers = events.map((e) => { const h = (data) => { cleanup(); res({ event: e, data }); }; sock.on(e, h); return [e, h]; });
    function cleanup() { clearTimeout(t); handlers.forEach(([e, h]) => sock.off(e, h)); }
  });
}
const jwk = (x) => ({ kty: 'EC', crv: 'P-256', x, y: `y${x}` });
const ask = async (sock, emit, data, events) => { const p = next(sock, events); sock.emit(emit, data); return p; };
const account = async (sock) => (await ask(sock, 'get-encrypted-key', undefined, ['encrypted-key-result'])).data;

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, FORCE_HTTP: 'true', ADMIN_USERNAME: 'admin' },
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

test.after(() => { open.forEach((s) => s.close()); server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

async function setUp(name) {
  const u = await register(name);
  const healthy = await connect(u.token);
  assert.equal((await ask(healthy, 'publish-public-key', { jwk: jwk(`${name}E1`) }, ['public-key-published', 'public-key-conflict'])).event, 'public-key-published');
  assert.equal((await ask(healthy, 'publish-signing-key', { jwk: jwk(`${name}S1`), backup: 'backup-S1', rid: 'a' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-published');
  return { u, healthy };
}

test('a device with an outdated encryption key cannot replace the signing key or its backup', async () => {
  const { u, healthy } = await setUp('stale1');
  const stale = await connect(u.token);
  assert.equal((await ask(stale, 'publish-public-key', { jwk: jwk('oldKey') }, ['public-key-published', 'public-key-conflict'])).event, 'public-key-conflict');
  const r = await ask(stale, 'publish-signing-key', { jwk: jwk('rogue'), backup: 'backup-rogue', force: true, rid: 'b' }, ['signing-key-published', 'signing-key-conflict']);
  assert.equal(r.event, 'signing-key-conflict');
  assert.equal(r.data.rid, 'b');
  assert.equal(r.data.stale, true);
  assert.equal((await ask(stale, 'store-signing-backup', { backup: 'backup-rogue' }, ['signing-backup-stored', 'error-msg'])).event, 'error-msg');
  const after = await account(healthy);
  assert.equal(after.signingKey.x, 'stale1S1', 'the pinned signing key is unchanged');
  assert.equal(after.signingBackup, 'backup-S1', 'the backup is unchanged');
  healthy.close(); stale.close();
});

test('an older app that syncs is still held to the pinned key, on any connection', async () => {
  const { u, healthy } = await setUp('stale2');
  const stale = await connect(u.token);
  await ask(stale, 'publish-public-key', { jwk: jwk('oldKey2') }, ['public-key-published', 'public-key-conflict']);
  // Older apps re-publish the synced key, while a replacement they decided on
  // with the old key may still be on its way.
  assert.equal((await ask(stale, 'publish-public-key', { jwk: jwk('stale2E1'), force: true }, ['public-key-published', 'public-key-conflict'])).event, 'public-key-published');
  assert.equal((await ask(stale, 'publish-signing-key', { jwk: jwk('late'), backup: 'backup-late', force: true, rid: 'l' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-conflict');
  // The app reconnects while signing in, so the request can come on another connection.
  const again = await connect(u.token);
  assert.equal((await ask(again, 'publish-signing-key', { jwk: jwk('later'), backup: 'backup-later', force: true, rid: 'l2' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-conflict');
  assert.equal((await account(healthy)).signingKey.x, 'stale2S1');
  // Using the pinned key needs nothing from the server, so the synced app works.
  // A new app names the key it now holds and is judged by that.
  assert.equal((await ask(stale, 'publish-signing-key', { jwk: jwk('stale2S1'), rid: 'm' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-published');
  assert.equal((await ask(stale, 'publish-signing-key', { jwk: jwk('stale2S2'), backup: 'backup-S2', force: true, ecdh: jwk('stale2E1'), rid: 'n' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-published');
  healthy.close(); stale.close();
});

test('a reset on a connection that conflicted frees it', async () => {
  const { u, healthy } = await setUp('stale3');
  const stale = await connect(u.token);
  await ask(stale, 'publish-public-key', { jwk: jwk('oldKey3') }, ['public-key-published', 'public-key-conflict']);
  assert.equal((await ask(stale, 'publish-public-key', { jwk: jwk('stale3E2'), force: true }, ['public-key-published', 'public-key-conflict'])).event, 'public-key-published');
  assert.equal((await ask(stale, 'publish-signing-key', { jwk: jwk('stale3S2'), backup: 'backup-S2', force: true, rid: 'o' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-published');
  assert.equal((await ask(stale, 'store-signing-backup', { backup: 'backup-S2b' }, ['signing-backup-stored', 'error-msg'])).event, 'signing-backup-stored');
  healthy.close(); stale.close();
});

test('an explicit key reset still replaces the signing key, from old apps too', async () => {
  const { healthy } = await setUp('reset1');
  assert.equal((await ask(healthy, 'publish-public-key', { jwk: jwk('reset1E2'), force: true }, ['public-key-published', 'public-key-conflict'])).event, 'public-key-published');
  const r = await ask(healthy, 'publish-signing-key', { jwk: jwk('reset1S2'), backup: 'backup-S2', force: true, rid: 'c' }, ['signing-key-published', 'signing-key-conflict']);
  assert.equal(r.event, 'signing-key-published');
  const after = await account(healthy);
  assert.equal(after.signingKey.x, 'reset1S2');
  assert.equal(after.signingBackup, 'backup-S2');
  healthy.close();
});

test('a healthy device that never conflicted keeps the old behaviour', async () => {
  const { u } = await setUp('healthy1');
  const other = await connect(u.token);
  // Every app publishes its key as it connects.
  assert.equal((await ask(other, 'publish-public-key', { jwk: jwk('healthy1E1') }, ['public-key-published', 'public-key-conflict'])).event, 'public-key-published');
  const r = await ask(other, 'publish-signing-key', { jwk: jwk('healthy1S2'), force: true, rid: 'd' }, ['signing-key-published', 'signing-key-conflict']);
  assert.equal(r.event, 'signing-key-published', 'clients in the field that never send ecdh are not affected');
  assert.equal((await ask(other, 'publish-signing-key', { jwk: jwk('healthy1S3'), rid: 'e' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-conflict', 'an unforced replace is still refused');
  other.close();
});

test('a client that names its encryption key is held to the published one', async () => {
  const { healthy } = await setUp('claim1');
  const wrong = await ask(healthy, 'publish-signing-key', { jwk: jwk('claim1S2'), force: true, ecdh: jwk('notMine'), rid: 'f' }, ['signing-key-published', 'signing-key-conflict']);
  assert.equal(wrong.event, 'signing-key-conflict');
  const right = await ask(healthy, 'publish-signing-key', { jwk: jwk('claim1S2'), force: true, ecdh: jwk('claim1E1'), rid: 'g' }, ['signing-key-published', 'signing-key-conflict']);
  assert.equal(right.event, 'signing-key-published');
  healthy.close();
});

test('a connection that conflicted cannot set up the first signing key either', async () => {
  const u = await register('first1');
  const a = await connect(u.token);
  await ask(a, 'publish-public-key', { jwk: jwk('first1E1') }, ['public-key-published']);
  const b = await connect(u.token);
  await ask(b, 'publish-public-key', { jwk: jwk('other') }, ['public-key-conflict']);
  assert.equal((await ask(b, 'publish-signing-key', { jwk: jwk('first1S1'), backup: 'sealed-to-old', rid: 'h' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-conflict');
  assert.equal((await ask(a, 'publish-signing-key', { jwk: jwk('first1S1'), backup: 'backup-ok', ecdh: jwk('first1E1'), rid: 'i' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-published');
  a.close(); b.close();
});

test('a connection that has not shown its key cannot replace the signing key', async () => {
  const { u, healthy } = await setUp('early1');
  // Older apps could set up signing from the group screen before publishing
  // their key, and a stale one would then replace the account's signing key.
  const early = await connect(u.token);
  assert.equal((await ask(early, 'publish-signing-key', { jwk: jwk('early'), backup: 'backup-early', force: true, rid: 'p' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-conflict');
  assert.equal((await ask(early, 'store-signing-backup', { backup: 'backup-early' }, ['signing-backup-stored', 'error-msg'])).event, 'error-msg');
  assert.equal((await account(healthy)).signingBackup, 'backup-S1');
  // Reading the key and using the pinned one need no proof.
  assert.equal((await ask(early, 'publish-signing-key', { jwk: jwk('early1S1'), rid: 'q' }, ['signing-key-published', 'signing-key-conflict'])).event, 'signing-key-published');
  healthy.close(); early.close();
});

test('the mark lasts minutes, not forever', () => {
  const e2eStale = require('../src/e2eStale');
  const real = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    e2eStale.mark(999001);
    assert.equal(e2eStale.isStale(999001), true);
    now += e2eStale.WINDOW_MS - 1;
    assert.equal(e2eStale.isStale(999001), true);
    now += 2;
    assert.equal(e2eStale.isStale(999001), false);
    e2eStale.mark(999002);
    e2eStale.clear(999002);
    assert.equal(e2eStale.isStale(999002), false);
  } finally { Date.now = real; }
});

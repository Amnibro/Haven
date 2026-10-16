'use strict';

/**
 * Pictures sent together show as a grid or full size, one under another
 * (#5799). The admin sets the server's default (media_group_layout) and each
 * member may pick their own, saved on their account. Both are checked here
 * against a real server on a scratch port and data dir:
 *   node --test test/mediaGroupLayout.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { checkSetting } = require('../src/serverTemplate');
const { MEDIA_GROUP_LAYOUTS } = require('../src/mediaGroup');

const PORT = 3463;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-media-layout-${Date.now()}`);

let server;
const clients = [];

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (resp) => {
    let out = ''; resp.on('data', (c) => { out += c; }); resp.on('end', () => res(JSON.parse(out || '{}')));
  });
  r.on('error', rej); r.end(d);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const register = (username) => post('/api/auth/register', { username, password: 'layout12345', eulaVersion: '2.0', ageVerified: true });

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
// Sends `event` and resolves with the first `reply` event, or null after a while.
function ask(sock, event, data, reply, ms = 1500) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(reply, on); res(null); }, ms);
    function on(payload) { clearTimeout(t); sock.off(reply, on); res(payload); }
    sock.on(reply, on);
    sock.emit(event, data);
  });
}
const settings = (sock) => ask(sock, 'get-server-settings', undefined, 'server-settings');
const prefs = (sock) => ask(sock, 'get-preferences', undefined, 'preferences');

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
    } catch { await wait(500); } // not listening yet: try again
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
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('the layouts are grid and stacked, and templates carry only those', () => {
  assert.deepEqual(MEDIA_GROUP_LAYOUTS, ['grid', 'stacked']);
  assert.equal(checkSetting('media_group_layout', 'stacked'), 'stacked');
  assert.equal(checkSetting('media_group_layout', ' grid '), 'grid');
  assert.equal(checkSetting('media_group_layout', 'mosaic'), null);
  assert.equal(checkSetting('media_group_layout', ''), null);
});

test('the admin sets the server default; members see it change and cannot set it', async () => {
  const admin = await register('admin');
  const member = await register('layoutmember');
  const A = await connect(admin.token);
  const M = await connect(member.token);

  assert.equal((await settings(M)).media_group_layout, 'grid', 'a new server shows the grid');

  // Anything but the two layouts is refused without a word.
  assert.equal(await ask(A, 'update-server-setting', { key: 'media_group_layout', value: 'mosaic' }, 'server-setting-changed', 800), null);
  assert.equal((await settings(M)).media_group_layout, 'grid');

  const changed = await ask(A, 'update-server-setting', { key: 'media_group_layout', value: 'stacked' }, 'server-setting-changed');
  assert.deepEqual(changed, { key: 'media_group_layout', value: 'stacked' });
  await wait(200);
  assert.equal((await settings(M)).media_group_layout, 'stacked', 'members are sent the new default');

  const refused = await ask(M, 'update-server-setting', { key: 'media_group_layout', value: 'grid' }, 'error-msg');
  assert.match(String(refused), /admins/i);
  assert.equal((await settings(M)).media_group_layout, 'stacked');
});

test('a member saves their own layout on the account and can go back to the default', async () => {
  const login = await post('/api/auth/login', { username: 'layoutmember', password: 'layout12345', eulaVersion: '2.0', ageVerified: true });
  const M = await connect(login.token);

  assert.equal(await ask(M, 'set-preference', { key: 'media_group_layout', value: 'mosaic' }, 'preference-saved', 800), null);
  assert.equal((await prefs(M)).media_group_layout, undefined, 'no row means the server default');

  assert.deepEqual(await ask(M, 'set-preference', { key: 'media_group_layout', value: 'grid' }, 'preference-saved'), { key: 'media_group_layout', value: 'grid' });
  // Another device of the same account gets it with the rest of the preferences.
  const other = await connect(login.token);
  assert.equal((await prefs(other)).media_group_layout, 'grid');

  assert.deepEqual(await ask(M, 'delete-preference', { key: 'media_group_layout' }, 'preference-deleted'), { key: 'media_group_layout' });
  assert.equal((await prefs(M)).media_group_layout, undefined);
});

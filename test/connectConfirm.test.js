/**
 * Linking Steam or Spotify opens a page that names the Haven account first,
 * and only a click on that page starts the link. A link someone else made for
 * their own account cannot quietly attach your Steam or Spotify to it.
 *
 *   node --test test/connectConfirm.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3422;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-connect-confirm-${Date.now()}`);
let server;
const clients = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const request = (method, p, { body, headers = {} } = {}) => new Promise((res, rej) => {
  const h = { ...headers };
  if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(body); }
  const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: h }, (x) => {
    let b = ''; x.on('data', (c) => (b += c));
    x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }));
  });
  r.on('error', rej); if (body) r.write(body); r.end();
});
const register = (username) => new Promise((res, rej) => {
  const d = JSON.stringify({ username, password: 'connecttest123', eulaVersion: '2.0', ageVerified: true });
  const r = http.request({ host: 'localhost', port: PORT, path: '/api/auth/register', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res(JSON.parse(b))); });
  r.on('error', rej); r.write(d); r.end();
});

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true', STEAM_API_KEY: 'test-key', SPOTIFY_CLIENT_ID: 'test-id', SPOTIFY_CLIENT_SECRET: 'test-secret' },
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

test('a Steam link asks first, and only a click on that page starts it', async () => {
  const eve = await register('eve');
  const s = io(BASE, { auth: { token: eve.token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
  const got = new Promise((res) => s.once('connect-token', res));
  s.emit('get-connect-token', { provider: 'steam' });
  const { token } = await got;
  assert.ok(token, 'link token issued');

  const page = await request('GET', `/connect/steam?token=${encodeURIComponent(token)}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /<b>eve<\/b>/, 'the page names the Haven account');
  assert.ok(!/steamcommunity\.com\/openid\/login\?/.test(page.headers.location || ''), 'no redirect yet');
  assert.match(page.headers['content-security-policy'] || '', /frame-ancestors 'none'/, 'cannot be framed');

  const form = `token=${encodeURIComponent(token)}`;
  const crossSite = await request('POST', '/connect/steam/go', { body: form, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(crossSite.status, 403, 'another site cannot press Continue');
  const noHeaders = await request('POST', '/connect/steam/go', { body: form });
  assert.strictEqual(noHeaders.status, 403, 'nor a request with no origin at all');
  const clicked = await request('POST', '/connect/steam/go', { body: form, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(clicked.status, 303, 'Continue goes on to Steam');
  assert.match(clicked.headers.location, /^https:\/\/steamcommunity\.com\/openid\/login\?/);

  // An assertion made for some other site is refused before Steam is asked.
  const forged = new URLSearchParams({
    token,
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561197960287930',
    'openid.identity': 'https://steamcommunity.com/openid/id/76561197960287930',
    'openid.return_to': 'https://elsewhere.example/login',
  });
  const cb = await request('GET', `/connect/steam/callback?${forged}`);
  assert.strictEqual(cb.status, 400, 'refused');
});

test('a Spotify consent link only finishes in the browser that pressed Continue', async () => {
  const sam = await register('sam');
  const s = io(BASE, { auth: { token: sam.token }, transports: ['websocket'], forceNew: true });
  clients.push(s);
  await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
  const got = new Promise((res) => s.once('connect-token', res));
  s.emit('get-connect-token', { provider: 'spotify' });
  const { token } = await got;
  const go = await request('POST', '/connect/spotify/go', { body: `token=${encodeURIComponent(token)}`, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(go.status, 303);
  assert.match(go.headers.location, /^https:\/\/accounts\.spotify\.com\/authorize\?/);
  assert.ok((go.headers['set-cookie'] || []).some((c) => c.startsWith('haven_spotify_bind=') && /HttpOnly/i.test(c)), 'the browser gets a cookie');
  // Someone else's browser, with the consent link forwarded to it, has no cookie.
  const elsewhere = await request('GET', `/connect/spotify/callback?state=${encodeURIComponent(token)}&code=abc`);
  assert.strictEqual(elsewhere.status, 400, 'refused before any token exchange');
});

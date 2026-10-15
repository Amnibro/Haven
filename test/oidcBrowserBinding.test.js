/**
 * An SSO login finishes only in the browser that started it. Without that,
 * someone could start a login with their own account and send the callback
 * link to someone else, who would end up signed in as them.
 *
 *   node --test test/oidcBrowserBinding.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const PORT = 3419;
const IDP_PORT = 3420;
const ISSUER = `http://localhost:${IDP_PORT}`;
const DATA = path.join(os.tmpdir(), `haven-oidc-bind-${Date.now()}`);
let server, idp;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, cookie) => new Promise((res, rej) => {
  const headers = cookie ? { Cookie: cookie } : {};
  http.get({ host: 'localhost', port: PORT, path: p, headers }, (x) => {
    x.resume();
    res({ status: x.statusCode, location: x.headers.location || '', setCookie: x.headers['set-cookie'] || [] });
  }).on('error', rej);
});

test.before(async () => {
  // A provider that publishes discovery and refuses every code exchange, so a
  // callback that gets past the browser check fails at the exchange instead.
  idp = http.createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        code_challenge_methods_supported: ['S256'],
      }));
    }
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });
  await new Promise((r) => idp.listen(IDP_PORT, r));

  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true', OIDC_CLIENT_SECRET: 'test-secret' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`http://localhost:${PORT}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      break;
    } catch { await wait(500); }
  }
  const db = new Database(path.join(DATA, 'haven.db'));
  try {
    const set = db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)');
    set.run('oidc_enabled', '1');
    set.run('oidc_issuer_url', ISSUER);
    set.run('oidc_client_id', 'haven-test');
  } finally { db.close(); }
});
test.after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  await new Promise((r) => idp.close(r));
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

const start = async () => {
  const r = await get('/api/auth/oidc/start');
  assert.strictEqual(r.status, 302, 'start redirects to the provider');
  const state = new URL(r.location).searchParams.get('state');
  const cookie = r.setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('haven_oidc_bind='));
  assert.ok(state && cookie, 'a state and a browser cookie');
  assert.ok(r.setCookie.some((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)), 'the cookie is HttpOnly and SameSite=Lax');
  return { state, cookie };
};

test('the callback needs the cookie of the browser that started the login', async () => {
  const mine = await start();
  const elsewhere = await get(`/api/auth/oidc/callback?state=${mine.state}&code=abc`);
  assert.match(elsewhere.location, /oidc_error=expired/, 'another browser is turned away');

  const theirs = await start();
  const wrong = await get(`/api/auth/oidc/callback?state=${theirs.state}&code=abc`, mine.cookie);
  assert.match(wrong.location, /oidc_error=expired/, 'a cookie from another login does not count');

  const again = await start();
  const same = await get(`/api/auth/oidc/callback?state=${again.state}&code=abc`, again.cookie);
  assert.match(same.location, /oidc_error=exchange_failed/, 'the starting browser gets through to the code exchange');
});

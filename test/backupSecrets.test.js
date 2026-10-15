/**
 * A backup carries no two-factor secrets or one-time codes. With someone's
 * secret, whoever held the backup could make their codes, and an admin could
 * reset that person's password and sign in as them.
 *
 *   node --test test/backupSecrets.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const OTPAuth = require('otpauth');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');

const PORT = 3411;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-backup-secrets-${Date.now()}`);
let server;

const call = (method, p, body, token) => new Promise((res, rej) => {
  const d = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = { raw: b }; } res({ status: x.statusCode, body: j }); }); });
  r.on('error', rej); if (d) r.write(d); r.end();
});
const download = (p, token, file) => new Promise((res, rej) => {
  http.get({ host: 'localhost', port: PORT, path: p, headers: { Authorization: `Bearer ${token}` } }, (x) => {
    if (x.statusCode !== 200) return rej(new Error(`HTTP ${x.statusCode}`));
    const out = fs.createWriteStream(file);
    x.pipe(out);
    out.on('finish', res);
  }).on('error', rej);
});
const extract = (zip, name, dest) => new Promise((res, rej) => {
  yauzl.open(zip, { lazyEntries: true }, (err, z) => {
    if (err) return rej(err);
    z.on('entry', (e) => {
      if (e.fileName !== name) return z.readEntry();
      z.openReadStream(e, (err2, s) => {
        if (err2) return rej(err2);
        const out = fs.createWriteStream(dest);
        s.pipe(out);
        out.on('finish', () => { z.close(); res(true); });
      });
    });
    z.on('end', () => res(false));
    z.readEntry();
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('backups leave out two-factor secrets and codes', async () => {
  const PW = 'backuptest123';
  const reg = (u) => call('POST', '/api/auth/register', { username: u, password: PW, eulaVersion: '2.0', ageVerified: true });
  const admin = (await reg('admin')).body;
  const bob = (await reg('bob')).body;
  const setup = await call('POST', '/api/auth/totp/setup', {}, bob.token);
  const totpCode = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.base32Secret), digits: 6, period: 30 }).generate();
  const on = await call('POST', '/api/auth/totp/verify-setup', { code: totpCode, password: PW }, bob.token);
  assert.strictEqual(on.status, 200, JSON.stringify(on.body));

  const zip = path.join(DATA, 'backup.zip');
  await download('/api/admin/backup?include=messages', admin.token, zip);
  const dbFile = path.join(DATA, 'restored.db');
  assert.ok(await extract(zip, 'haven.db', dbFile), 'the backup has a database');

  const copy = new Database(dbFile, { readonly: true });
  try {
    const row = copy.prepare("SELECT totp_secret, totp_enabled, password_hash FROM users WHERE username = 'bob'").get();
    assert.strictEqual(row.totp_secret, null, 'no 2FA secret');
    assert.strictEqual(row.totp_enabled, 0, '2FA off in the copy');
    assert.ok(row.password_hash, 'the password hash stays, so people can still log in after a restore');
    assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM totp_backup_codes').get().n, 0, 'no backup codes');
  } finally { copy.close(); }

  const live = new Database(path.join(DATA, 'haven.db'), { readonly: true });
  try {
    assert.ok(live.prepare("SELECT totp_secret FROM users WHERE username = 'bob'").get().totp_secret, 'the live server keeps it');
  } finally { live.close(); }
});

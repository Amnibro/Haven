/**
 * Recovery codes need a full session. The token handed out after the
 * password but before the two-factor code is signed with the same key, and
 * once got recovery codes, which reset the password and turn two-factor off:
 * the password alone was enough to take a 2FA account.
 *
 *   node --test test/recoveryCodesSession.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const OTPAuth = require('otpauth');

const PORT = 3408;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-recovery-session-${Date.now()}`);
let server;

const call = (method, p, body, token) => new Promise((res, rej) => {
  const d = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = { raw: b }; } res({ status: x.statusCode, body: j }); }); });
  r.on('error', rej); if (d) r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait until the 30 second code changes.
const waitForNextStep = async () => {
  const step = Math.floor(Date.now() / 30000);
  while (Math.floor(Date.now() / 30000) === step) await wait(250);
};
const code = (secret) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

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

test('the two-factor challenge token cannot get recovery codes', { timeout: 120000 }, async () => {
  const PW = 'recoverytest123';
  const reg = await call('POST', '/api/auth/register', { username: 'victim', password: PW, eulaVersion: '2.0', ageVerified: true });
  assert.ok(reg.body.token, 'registered');
  const setup = await call('POST', '/api/auth/totp/setup', {}, reg.body.token);
  assert.ok(setup.body.base32Secret, 'two-factor setup started: ' + JSON.stringify(setup.body));
  const noPw = await call('POST', '/api/auth/totp/verify-setup', { code: code(setup.body.base32Secret) }, reg.body.token);
  assert.strictEqual(noPw.status, 400, 'turning 2FA on asks for the password');
  const wrongPw = await call('POST', '/api/auth/totp/verify-setup', { code: code(setup.body.base32Secret), password: 'not-it-123' }, reg.body.token);
  assert.strictEqual(wrongPw.status, 401, 'and checks it');
  await wait(1100);
  const verified = await call('POST', '/api/auth/totp/verify-setup', { code: code(setup.body.base32Secret), password: PW }, reg.body.token);
  assert.strictEqual(verified.status, 200, 'two-factor on: ' + JSON.stringify(verified.body));

  const login = await call('POST', '/api/auth/login', { username: 'victim', password: PW, eulaVersion: '2.0', ageVerified: true });
  assert.ok(login.body.requiresTOTP && login.body.challengeToken, 'login stops at the code prompt: ' + JSON.stringify(login.body));

  const gen = await call('POST', '/api/auth/recovery-codes/generate', { password: PW }, login.body.challengeToken);
  assert.strictEqual(gen.status, 401, 'refused with only the password: ' + JSON.stringify(gen.body));
  assert.ok(!gen.body.codes, 'no codes');
  const status = await call('GET', '/api/auth/recovery-codes/status', null, login.body.challengeToken);
  assert.strictEqual(status.status, 401);

  // Past the code prompt, it works as before. The code used to turn 2FA on
  // was spent, so wait for the next one.
  await waitForNextStep();
  const used = code(setup.body.base32Secret);
  const full = await call('POST', '/api/auth/totp/validate', { challengeToken: login.body.challengeToken, code: used });
  assert.ok(full.body.token, 'second factor accepted: ' + JSON.stringify(full.body));
  // The same code does not work a second time.
  const again = await call('POST', '/api/auth/login', { username: 'victim', password: PW, eulaVersion: '2.0', ageVerified: true });
  const replay = await call('POST', '/api/auth/totp/validate', { challengeToken: again.body.challengeToken, code: used });
  assert.strictEqual(replay.status, 401, 'a used code is refused: ' + JSON.stringify(replay.body));
  const ok = await call('POST', '/api/auth/recovery-codes/generate', { password: PW }, full.body.token);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
});

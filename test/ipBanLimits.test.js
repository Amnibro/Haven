/**
 * IP bans cannot lock out the people who would have to lift them: no range
 * wide enough to cover everyone (a Mod once banned 0.0.0.0/0 and the whole
 * server went dark, the admin included), not this machine, not the person
 * banning, and not anyone ranked at or above them. Lifting someone else's
 * IP ban follows the same rank rule as lifting a user ban.
 *
 *   node --test test/ipBanLimits.test.js
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

const PORT = 3409;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-ipban-limits-${Date.now()}`);

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


const writeDb = (sql, ...args) => {
  const db = new Database(path.join(DATA, 'haven.db'));
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
};
const ipBans = () => readDb('SELECT ip FROM ip_bans').map((r) => r.ip);
async function tryBan(sock, ip) {
  const reply = next(sock, 'error-msg', () => true, 3000);
  sock.emit('ban-ip', { ip, reason: 'test' });
  return (await reply) || '';
}

test('IP bans stop short of locking out staff', async () => {
  const admin = await register('admin');
  const mod = await register('mod');
  const A = await connect(admin.token), M = await connect(mod.token);
  const modRole = readDb("SELECT id FROM roles WHERE name = 'Mod'")[0];
  assert.ok(modRole, 'the default Mod role exists');
  const assigned = await new Promise((r) => A.emit('assign-role', { userId: mod.user.id, roleId: modRole.id }, r));
  assert.ok(assigned && assigned.success, 'mod assigned: ' + JSON.stringify(assigned));
  await wait(300);

  assert.match(await tryBan(M, '0.0.0.0/0'), /too wide/);
  assert.match(await tryBan(M, '::/0'), /too wide/);
  assert.match(await tryBan(M, '10.0.0.0/8'), /too wide/, 'a moderator stops at /16');
  assert.match(await tryBan(M, '127.0.0.1'), /own machine|your own|you use/);
  assert.deepStrictEqual(ipBans(), [], 'none of those went in');

  // An address the admin has used is off limits to a moderator.
  writeDb('INSERT INTO user_ips (user_id, ip) VALUES (?, ?)', admin.user.id, '198.51.100.7');
  assert.match(await tryBan(M, '198.51.100.0/24'), /admin/);
  // And to the admin too, since it is their own.
  assert.match(await tryBan(A, '198.51.100.7'), /you use|your own/);

  // An ordinary address goes in.
  assert.match(await tryBan(M, '203.0.113.9'), /Banned IP 203\.0\.113\.9/);
  assert.match(await tryBan(A, '192.0.2.0/24'), /Banned IP 192\.0\.2\.0\/24/, 'the admin may ban a /24');
  assert.ok(ipBans().includes('203.0.113.9') && ipBans().includes('192.0.2.0/24'));

  // The moderator cannot lift the admin's ban; the admin can lift the moderator's.
  const refused = next(M, 'error-msg', () => true, 3000);
  M.emit('unban-ip', { ip: '192.0.2.0/24' });
  assert.match(await refused, /placed by an admin/);
  assert.ok(ipBans().includes('192.0.2.0/24'));
  A.emit('unban-ip', { ip: '203.0.113.9' });
  await wait(300);
  assert.ok(!ipBans().includes('203.0.113.9'));
});

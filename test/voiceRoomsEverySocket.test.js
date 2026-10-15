/**
 * Someone with Haven open in two places (the desktop app and a phone, say)
 * sees voice rooms update in both, including channels joined or created on
 * the other device after this one connected (#5782).
 *
 *   node --test test/voiceRoomsEverySocket.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3446;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-voice-rooms-${Date.now()}`);

let server;
const clients = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const register = (username) =>
  post('/api/auth/register', { username, password: 'voicerooms123', eulaVersion: '2.0', ageVerified: true });
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

test('a channel joined on one device reports its voice room on the other too', async () => {
  const admin = await register('admin');
  const carol = await register('carol');
  const dave = await register('dave');
  const A = await connect(admin.token);
  const made = next(A, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'lounge'));
  A.emit('create-channel', { name: 'lounge' });
  const code = (await made).find((c) => c.name === 'lounge').code;

  // Carol has the desktop app open already, then joins on her phone.
  const desktop = await connect(carol.token);
  desktop.emit('get-channels');
  await next(desktop, 'channels-list');
  const phone = await connect(carol.token);
  const listed = next(desktop, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.code === code));
  phone.emit('join-channel', { code });
  assert.ok(await listed, 'the desktop app lists the channel joined on the phone');

  // Dave joins its voice room: the desktop app hears about it.
  const D = await connect(dave.token);
  D.emit('join-channel', { code });
  await wait(400);
  const heard = next(desktop, 'voice-count-update', (d) => d && d.code === code && d.count === 1);
  D.emit('voice-join', { code });
  const update = await heard;
  assert.ok(update, 'the desktop app got the voice room update');
  assert.deepEqual(update.users.map((u) => u.username), ['dave']);

  // A channel the admin creates on one device shows its voice room on another.
  const second = await connect(admin.token);
  second.emit('get-channels');
  await next(second, 'channels-list');
  const made2 = next(second, 'channels-list', (c) => Array.isArray(c) && c.some((x) => x.name === 'later'));
  A.emit('create-channel', { name: 'later' });
  const code2 = (await made2).find((c) => c.name === 'later').code;
  D.emit('join-channel', { code: code2 });
  await wait(400);
  const heard2 = next(second, 'voice-count-update', (d) => d && d.code === code2 && d.count === 1);
  D.emit('voice-join', { code: code2 });
  assert.ok(await heard2, "the admin's other device got the new channel's voice room update");
});

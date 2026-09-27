#!/usr/bin/env node
'use strict';
/**
 * Haven load tester.
 *
 * Starts a throwaway Haven server with its own empty data folder, fills it
 * with fake accounts, connects them all at once and measures what the server
 * goes through: people arriving, a steady stream of chat, people dropping off
 * and coming back, and status changes. It never touches a real server's data;
 * the temporary folder is deleted at the end unless --keep is given.
 *
 *   node scripts/loadtest.js --users 500
 *
 * Options (all optional):
 *   --users N          fake people to connect (default 300)
 *   --port N           port for the throwaway server (default 3990)
 *   --chat-seconds N   how long the chat phase runs (default 15)
 *   --rate N           chat messages per second across everyone (default 5)
 *   --churn N          people who drop off and reconnect (default 10% of users)
 *   --status N         people who change their status (default 10% of users)
 *   --json FILE        also write the results as JSON to FILE
 *   --legacy           act like an older app that needs every member list
 *                      in full, instead of only the changes
 *   --keep             keep the temporary data folder
 *
 * What the numbers mean:
 *   "server delay" is how long the server took to answer a tiny health check
 *   while the phase ran. It is the lag every user feels: if it reads 800 ms,
 *   every click and message waited that long behind the server's other work.
 *   "sent to clients" is everything the server pushed to all the fake people
 *   during the phase, with the event types that made up most of it.
 *   "message delay" is how long a chat message took to reach everyone.
 *
 * The fake people run in this one process on the same machine, so absolute
 * numbers depend on the computer. Compare runs on the same machine.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { io } = require(path.join(ROOT, 'node_modules', 'socket.io-client'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

// ── Options ──────────────────────────────────────────────
function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = readArgs(process.argv.slice(2));
const USERS = Math.max(2, parseInt(args.users, 10) || 300);
const PORT = parseInt(args.port, 10) || 3990;
const CHAT_SECONDS = Math.max(1, parseFloat(args['chat-seconds']) || 15);
const RATE = Math.max(0.1, parseFloat(args.rate) || 5);
const CHURN = Math.min(USERS, parseInt(args.churn, 10) || Math.max(1, Math.round(USERS / 10)));
const STATUS = Math.min(USERS, parseInt(args.status, 10) || Math.max(1, Math.round(USERS / 10)));
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Throwaway server ─────────────────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-loadtest-'));
const jwtSecret = crypto.randomBytes(32).toString('hex');
let server = null;

function startServer() {
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORCE_HTTP: 'true',
      PORT: String(PORT),
      HAVEN_DATA_DIR: dataDir,
      JWT_SECRET: jwtSecret,
    },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  server.on('exit', code => { if (!stopping) console.error(`\nThe test server stopped unexpectedly (exit ${code}). Its log: ${path.join(dataDir, 'server.log')}`); });
}

let stopping = false;
async function stopServer() {
  stopping = true;
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(r => { server.once('exit', r); setTimeout(r, 5000); });
  }
}

async function waitForServer() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('The test server did not start within 90 seconds');
}

// ── Fake accounts ────────────────────────────────────────
function seed() {
  const db = new Database(path.join(dataDir, 'haven.db'));
  db.pragma('busy_timeout = 10000');
  const hash = bcrypt.hashSync('loadtest-not-a-real-password', 4);
  const code = crypto.randomBytes(4).toString('hex');
  const insUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
  const insMember = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  const people = [];
  db.transaction(() => {
    const channelId = db.prepare('INSERT INTO channels (name, code) VALUES (?, ?)').run('lobby', code).lastInsertRowid;
    for (let i = 0; i < USERS; i++) {
      const username = `loadtest_${i}`;
      const id = Number(insUser.run(username, hash).lastInsertRowid);
      insMember.run(channelId, id);
      people.push({ id, username });
    }
  })();
  db.close();
  for (const p of people) {
    p.token = jwt.sign({ id: p.id, username: p.username, isAdmin: false, displayName: p.username, pwv: 1 }, jwtSecret, { expiresIn: '2h' });
  }
  return { code, people };
}

// ── Measuring ────────────────────────────────────────────
let phase = null;
const phases = [];

function newPhase(name) {
  phase = { name, started: Date.now(), ended: null, bytes: 0, packets: 0, byEvent: new Map(), health: [], msgDelays: [], sent: 0, errors: new Map() };
  phases.push(phase);
  return phase;
}
function endPhase() { phase.ended = Date.now(); }

// The server answers /api/health on the same thread that does all its other
// work, so how long that takes is how far behind the server is running.
let healthOn = true;
async function healthLoop() {
  while (healthOn) {
    const t0 = performance.now();
    try { await fetch(BASE + '/api/health'); } catch { /* counted as slow below */ }
    const ms = performance.now() - t0;
    if (phase && !phase.ended) phase.health.push(ms);
    await sleep(200);
  }
}

function countPacket(data) {
  if (!phase || phase.ended || typeof data !== 'string') return;
  phase.bytes += data.length;
  phase.packets++;
  const m = /^\d*\["([^"]+)"/.exec(data.slice(0, 80));
  const name = m ? m[1] : '(other)';
  phase.byEvent.set(name, (phase.byEvent.get(name) || 0) + data.length);
}

// ── Fake people ──────────────────────────────────────────
function fakeIp(i) {
  // Each person gets their own address so the per-address connection limit
  // treats them as separate people, the way it would on a real server.
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

function connect(person, i, code) {
  return new Promise((resolve) => {
    const socket = io(BASE, {
      transports: ['websocket'],
      auth: args.legacy ? { token: person.token } : { token: person.token, presenceDeltas: 1 },
      extraHeaders: { 'x-forwarded-for': fakeIp(i + 1) },
      forceNew: true,
      reconnection: false,
      timeout: 60000,
    });
    person.socket = socket;
    socket.io.on('open',() => socket.io.engine.on('packet', p => countPacket(p.data)));
    socket.on('new-message', ({ message }) => {
      const m = /^lt (\d+) (\d+)$/.exec(message?.content || '');
      if (m && phase && !phase.ended) phase.msgDelays.push(Date.now() - Number(m[2]));
    });
    socket.on('error-msg', msg => {
      if (!phase) return;
      const key = String(msg).slice(0, 60);
      phase.errors.set(key, (phase.errors.get(key) || 0) + 1);
    });
    socket.once('connect', () => {
      socket.emit('visibility-change', { visible: true });
      socket.emit('get-channels');
      socket.emit('enter-channel', { code });
      socket.emit('get-messages', { code });
      resolve(true);
    });
    socket.once('connect_error', err => {
      if (phase) phase.errors.set('connect: ' + err.message, (phase.errors.get('connect: ' + err.message) || 0) + 1);
      resolve(false);
    });
  });
}

async function connectAll(people, code, indexes) {
  // Arrive in small waves, like a burst of people opening the app, rather
  // than one impossible instant.
  let ok = 0;
  for (let s = 0; s < indexes.length; s += 25) {
    const wave = indexes.slice(s, s + 25).map(i => connect(people[i], i, code));
    ok += (await Promise.all(wave)).filter(Boolean).length;
    await sleep(50);
  }
  return ok;
}

// Wait until the server has gone quiet: no health check slower than 100 ms
// and no traffic for a second, or give up after `max` ms.
async function settle(max = 60000) {
  const until = Date.now() + max;
  let lastPackets = -1, quietSince = Date.now();
  while (Date.now() < until) {
    await sleep(250);
    const recent = phase.health.slice(-3);
    const busy = recent.some(ms => ms > 100);
    if (phase.packets !== lastPackets || busy) { lastPackets = phase.packets; quietSince = Date.now(); }
    else if (Date.now() - quietSince >= 1000) return true;
  }
  return false;
}

// ── Report ───────────────────────────────────────────────
function pct(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}
const ms = v => v == null ? '-' : `${Math.round(v)} ms`;
function size(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function summarize(p) {
  const top = [...p.byEvent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, b]) => ({ event: name, bytes: b, share: p.bytes ? Math.round(b / p.bytes * 100) : 0 }));
  return {
    phase: p.name,
    seconds: +(((p.ended || Date.now()) - p.started) / 1000).toFixed(1),
    sentToClients: p.bytes,
    topEvents: top,
    serverDelay: { p50: pct(p.health, 50), p95: pct(p.health, 95), max: p.health.length ? p.health.reduce((m, v) => Math.max(m, v), 0) : null },
    messages: p.sent ? { sent: p.sent, deliveries: p.msgDelays.length, expected: p.expected || null, p50: pct(p.msgDelays, 50), p95: pct(p.msgDelays, 95), max: p.msgDelays.length ? p.msgDelays.reduce((m, v) => Math.max(m, v), 0) : null } : null,
    errors: Object.fromEntries(p.errors),
    note: p.note || null,
  };
}

function printReport(rows) {
  console.log(`\nHaven load test: ${USERS} people in one channel${args.legacy ? ' (as older apps)' : ''}\n`);
  for (const r of rows) {
    console.log(`▸ ${r.phase} (${r.seconds}s)`);
    console.log(`    server delay   typical ${ms(r.serverDelay.p50)}, bad moments ${ms(r.serverDelay.p95)}, worst ${ms(r.serverDelay.max)}`);
    console.log(`    sent to clients ${size(r.sentToClients)}` + (r.topEvents.length ? `, mostly ${r.topEvents.map(e => `${e.event} ${e.share}%`).join(', ')}` : ''));
    if (r.messages) {
      const expected = r.messages.expected ? ` of ${r.messages.expected}` : '';
      console.log(`    messages       ${r.messages.sent} sent, ${r.messages.deliveries}${expected} deliveries, typical ${ms(r.messages.p50)}, bad ${ms(r.messages.p95)}, worst ${ms(r.messages.max)}`);
    }
    for (const [e, n] of Object.entries(r.errors)) console.log(`    error x${n}      ${e}`);
    if (r.note) console.log(`    note           ${r.note}`);
  }
  console.log('');
}

// ── Run ──────────────────────────────────────────────────
async function main() {
  console.log(`Starting a throwaway server on port ${PORT} (data in ${dataDir})...`);
  startServer();
  await waitForServer();
  const { code, people } = seed();
  console.log(`Created ${USERS} fake accounts. Connecting them...`);
  healthLoop();

  // 1. Everyone arrives.
  newPhase(`${USERS} people connect and open the channel`);
  const all = people.map((_, i) => i);
  const connected = await connectAll(people, code, all);
  if (!(await settle(120000))) phase.note = 'still busy when the phase was cut off after 2 minutes';
  if (connected < USERS) phase.note = `${USERS - connected} could not connect`;
  endPhase();

  // 2. Steady chat from random people.
  newPhase(`chat: ${RATE} messages a second for ${CHAT_SECONDS}s`);
  const online = people.filter(p => p.socket?.connected);
  const total = Math.round(RATE * CHAT_SECONDS);
  for (let n = 0; n < total; n++) {
    const who = online[Math.floor(Math.random() * online.length)];
    who.socket.emit('send-message', { code, content: `lt ${n} ${Date.now()}` });
    phase.sent++;
    await sleep(1000 / RATE);
  }
  phase.expected = phase.sent * online.length;
  await settle(30000);
  endPhase();

  // 3. Some people drop off and come back (a flaky network, a phone locking).
  newPhase(`${CHURN} people drop off and reconnect`);
  const churners = all.slice(0, CHURN);
  for (const i of churners) people[i].socket.disconnect();
  await sleep(500);
  await connectAll(people, code, churners);
  if (!(await settle(120000))) phase.note = 'still busy when the phase was cut off after 2 minutes';
  endPhase();

  // 4. Some people change their status.
  newPhase(`${STATUS} people change their status`);
  for (const i of all.slice(0, STATUS)) {
    people[i].socket.emit('set-status', { status: 'away', statusText: '' });
    await sleep(20);
  }
  if (!(await settle(120000))) phase.note = 'still busy when the phase was cut off after 2 minutes';
  endPhase();

  healthOn = false;
  for (const p of people) p.socket?.disconnect();

  const rows = phases.map(summarize);
  printReport(rows);
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ users: USERS, when: new Date().toISOString(), phases: rows }, null, 2));
    console.log(`Results written to ${args.json}`);
  }
}

main()
  .catch(err => { console.error('\nLoad test failed:', err.message); process.exitCode = 1; })
  .finally(async () => {
    healthOn = false;
    await stopServer();
    if (!args.keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* a file may still be locked */ } }
    else console.log(`Kept the test data in ${dataDir}`);
    setTimeout(() => process.exit(), 200).unref();
  });

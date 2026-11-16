'use strict';

// Offline end-to-end check, in a real browser. Opt-in because it needs
// Chromium and Playwright and takes about a minute:
//
//   HAVEN_E2E=1 node --test test/offline.e2e.test.js
//
// The server runs with no outbound proxy and the browser has every
// non-localhost request blocked, as on a LAN with no internet. It checks:
//  1. two accounts can register and talk with the internet unreachable
//     (every blocked external URL is printed: that is the dependency list);
//  2. messages written while the server is down are shown as pending and
//     arrive once each, in order, after it comes back;
//  3. reloading while the server is down opens the cached app, not a
//     browser error page;
//  4. a two-person voice call connects with an empty ICE server list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENABLED = process.env.HAVEN_E2E === '1';
let playwright = null;
if (ENABLED) { try { playwright = require('playwright'); } catch { /* skipped below */ } }

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'Offl1ne!pass';

// Loaded into the server with --require: every name lookup other than
// localhost fails the way it does with no internet, and is written to a file
// so the test can list what the server tried to reach.
const NO_INTERNET = `
const dns = require('dns'); const fs = require('fs');
const LOG = process.env.HAVEN_E2E_DNS_LOG;
const local = h => /^(localhost|127\\.|::1$|0\\.0\\.0\\.0$)/.test(String(h));
const deny = h => { try { fs.appendFileSync(LOG, h + '\\n'); } catch {} const e = new Error('getaddrinfo ENOTFOUND ' + h); e.code = 'ENOTFOUND'; e.hostname = h; return e; };
const orig = dns.lookup;
dns.lookup = function (h, o, cb) { if (typeof o === 'function') { cb = o; o = {}; } if (local(h)) return orig.call(dns, h, o, cb); process.nextTick(cb, deny(h)); };
const op = dns.promises.lookup;
dns.promises.lookup = (h, o) => local(h) ? op.call(dns.promises, h, o) : Promise.reject(deny(h));
`;

function serverEnv(dataDir) {
  const preload = path.join(dataDir, 'no-internet.cjs');
  fs.writeFileSync(preload, NO_INTERNET);
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, PORT: String(PORT), FORCE_HTTP: 'true', STUN_URLS: 'none',
    HAVEN_E2E_DNS_LOG: path.join(dataDir, 'dns.log'), NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY']) delete env[k];
  return env;
}

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: serverEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  child.on('exit', (c, sig) => { if (!child.stopping) console.log(`[server exited unexpectedly: ${c} ${sig}]\n` + log.slice(-3000)); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('server exited:\n' + log);
    try { if ((await fetch(BASE + '/')).ok) return child; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start:\n' + log);
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.stopping = true;
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}

async function newClient(browser, external) {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = route.request().url();
    const u = new URL(url);
    if (/^https?:$|^wss?:$/.test(u.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      external.add(url);
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  return { context, page };
}

async function register(page, username) {
  await page.goto(BASE + '/');
  await page.click('[data-tab="register"]');
  await page.fill('#reg-username', username);
  await page.fill('#reg-password', PASSWORD);
  await page.fill('#reg-confirm', PASSWORD);
  await page.check('#age-checkbox');
  await page.check('#eula-checkbox');
  await page.click('#register-form button[type=submit]');
  await page.waitForURL('**/app**', { timeout: 20000 });
  await page.waitForFunction(() => window.app && window.app.socket && window.app.socket.connected, null, { timeout: 20000 });
}

async function openChannel(page, code) {
  await page.evaluate(c => window.app.switchChannel(c), code);
  await page.waitForFunction(c => window.app.currentChannel === c, code);
  await page.keyboard.press('Escape').catch(() => {});
  // Dismiss onboarding modals that would cover the composer.
  await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; }));
}

async function send(page, text) {
  await page.evaluate(t => {
    const input = document.getElementById('message-input');
    input.value = t;
    return window.app._sendMessage();
  }, text);
}

const texts = page => page.$$eval('#messages .message .message-content, #messages .message-compact .message-content',
  els => els.map(e => e.textContent.trim()));

test('Haven works on a LAN with no internet and survives losing the server', { skip: !ENABLED ? 'set HAVEN_E2E=1 to run' : !playwright && 'playwright not installed', timeout: 240000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.HAVEN_E2E_TMP || os.tmpdir(), 'haven-offline-'));
  const external = new Set();
  let server = await startServer(dataDir);
  const browser = await playwright.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    // ── 1. LAN only: register two accounts and talk ──
    const a = await newClient(browser, external);
    const b = await newClient(browser, external);
    await register(a.page, 'admin');
    const code = await a.page.evaluate(() => new Promise(resolve => {
      window.app.socket.once('channel-created', ch => resolve(ch.code));
      window.app.socket.emit('create-channel', { name: 'lan' });
    }));
    assert.match(code, /^[a-f0-9]{8}$/);
    await register(b.page, 'bob_lan');
    await b.page.evaluate(c => window.app.socket.emit('join-channel', { code: c }), code);
    await b.page.waitForFunction(c => window.app.channels.some(ch => ch.code === c), code, { timeout: 10000 });
    const code2 = await a.page.evaluate(() => new Promise(resolve => {
      window.app.socket.once('channel-created', ch => resolve(ch.code));
      window.app.socket.emit('create-channel', { name: 'lan2' });
    }));
    await b.page.evaluate(c => window.app.socket.emit('join-channel', { code: c }), code2);
    await b.page.waitForFunction(c => window.app.channels.some(ch => ch.code === c), code2, { timeout: 10000 });
    await openChannel(a.page, code2);
    await send(a.page, 'second channel note');
    await openChannel(b.page, code2);
    await b.page.waitForFunction(() => document.getElementById('messages').textContent.includes('second channel note'), null, { timeout: 10000 });
    await openChannel(a.page, code);
    await openChannel(b.page, code);

    await send(a.page, 'hello from a');
    await b.page.waitForFunction(() => document.getElementById('messages').textContent.includes('hello from a'), null, { timeout: 10000 });
    await send(b.page, 'hello from b');
    await a.page.waitForFunction(() => document.getElementById('messages').textContent.includes('hello from b'), null, { timeout: 10000 });

    // Files: upload a picture and post it; the other side loads it.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await a.page.evaluate(async b64 => {
      const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: 'image/png' }), 'dot.png');
      const r = await fetch('/api/upload', { method: 'POST', body: form, headers: { Authorization: 'Bearer ' + localStorage.getItem('haven_token') } });
      return { status: r.status, body: await r.json() };
    }, png);
    assert.equal(up.status, 200, 'upload works offline: ' + JSON.stringify(up.body));
    await send(a.page, up.body.url);
    await b.page.waitForFunction(u => [...document.querySelectorAll('#messages img')].some(i => i.src.includes(u) && i.complete && i.naturalWidth > 0), up.body.url, { timeout: 10000 });

    // Internet-only extras fail fast and cleanly instead of hanging.
    const extras = await a.page.evaluate(async () => {
      const h = { Authorization: 'Bearer ' + localStorage.getItem('haven_token') };
      const out = {};
      for (const u of ['/api/link-preview?url=' + encodeURIComponent('https://example.org/'), '/api/gif/search?q=cat']) {
        const t0 = performance.now();
        const r = await fetch(u, { headers: h });
        out[u] = { status: r.status, ms: Math.round(performance.now() - t0) };
      }
      return out;
    });
    console.log('[internet-only extras]', JSON.stringify(extras));
    for (const r of Object.values(extras)) assert.ok(r.ms < 15000, 'answered without hanging');

    // Reactions.
    const lastId = await b.page.evaluate(() => Number([...document.querySelectorAll('#messages [data-msg-id]')].pop().dataset.msgId));
    await b.page.evaluate(id => window.app.socket.emit('add-reaction', { messageId: id, emoji: '👍' }), lastId);
    await a.page.waitForSelector(`#messages [data-msg-id="${lastId}"] .reaction-badge`, { timeout: 10000 });

    // Encrypted DMs (keys are made and used in the browser).
    const bId = await b.page.evaluate(() => window.app.user.id);
    const dmCode = await a.page.evaluate(id => new Promise(resolve => {
      window.app.socket.once('dm-opened', ch => resolve(ch.code));
      window.app.socket.emit('start-dm', { targetUserId: id });
    }), bId);
    await b.page.waitForFunction(c => window.app.channels.some(ch => ch.code === c), dmCode, { timeout: 10000 });
    await openChannel(a.page, dmCode);
    await send(a.page, 'private hello');
    await openChannel(b.page, dmCode);
    await b.page.waitForFunction(() => document.getElementById('messages').textContent.includes('private hello'), null, { timeout: 15000 });
    await openChannel(a.page, code);
    await openChannel(b.page, code);

    // ── 4. Voice between two LAN peers with an empty ICE list ──
    const ice = await a.page.evaluate(async () => (await fetch('/api/ice-servers', { headers: { Authorization: 'Bearer ' + localStorage.getItem('haven_token') } })).json());
    assert.deepEqual(ice.iceServers, [], 'STUN_URLS=none gives an empty ICE list');
    const voice = await (async () => {
      try {
        await a.page.evaluate(c => window.app.voice.join(c), code);
        await b.page.evaluate(c => window.app.voice.join(c), code);
        await a.page.waitForFunction(() => [...(window.app.voice.peers?.values?.() || [])].some(p => p.connection && ['connected', 'completed'].includes(p.connection.iceConnectionState)), null, { timeout: 20000 });
        return 'connected';
      } catch (err) {
        return 'not verified: ' + err.message.split('\n')[0];
      }
    })();
    console.log('[voice]', voice);
    await a.page.evaluate(() => window.app.voice.leave?.()).catch(() => {});
    await b.page.evaluate(() => window.app.voice.leave?.()).catch(() => {});

    // Give the service worker time to take control and fill its cache.
    await b.page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
    await b.page.waitForFunction(async () => (await (await caches.open('haven-shell-v1')).keys()).length > 20, null, { timeout: 15000, polling: 500 });

    // ── 2. Server goes away: the UI stays, messages queue, then send once ──
    await stopServer(server);
    await b.page.waitForSelector('#offline-banner', { timeout: 15000 });
    assert.ok((await texts(b.page)).some(t => t.includes('hello from a')), 'loaded messages stay readable');
    // Recently viewed channels can still be read while offline.
    await b.page.evaluate(c => window.app.switchChannel(c), code2);
    assert.ok((await texts(b.page)).some(t => t.includes('second channel note')), 'a recently viewed channel opens offline');
    await b.page.evaluate(c => window.app.switchChannel(c), code);
    assert.ok((await texts(b.page)).some(t => t.includes('hello from a')), 'and back again');
    for (const n of [1, 2, 3]) await send(b.page, `queued ${n}`);
    assert.equal(await b.page.locator('#messages .message-pending').count(), 3, 'three pending messages shown');
    assert.match(await b.page.textContent('#offline-banner'), /3/);

    // ── 3. Reload while the server is down: the cached app opens ──
    const c = await b.context.newPage();
    const resp = await c.goto(BASE + '/app');
    assert.ok(resp, 'a response came back');
    await c.waitForSelector('#message-input', { state: 'attached', timeout: 15000 });
    await c.waitForSelector('#offline-banner', { timeout: 15000 });
    console.log('[offline reload] status', resp.status(), 'from service worker:', resp.fromServiceWorker());
    await c.close();

    // Bring the server back; the pending messages go out in order, once.
    server = await startServer(dataDir);
    await b.page.waitForFunction(() => window.app.socket.connected && !document.getElementById('offline-banner'), null, { timeout: 30000 });
    await a.page.waitForFunction(() => window.app.socket.connected, null, { timeout: 30000 });
    await a.page.evaluate(c => window.app.switchChannel(c), code);
    await a.page.waitForFunction(() => document.getElementById('messages').textContent.includes('queued 3'), null, { timeout: 15000 });
    await b.page.waitForTimeout(3000); // any duplicate would have arrived by now
    await a.page.evaluate(c => window.app.switchChannel(c), code);
    await a.page.waitForTimeout(1500);
    const seen = (await texts(a.page)).filter(t => /^queued \d$/.test(t));
    assert.deepEqual(seen, ['queued 1', 'queued 2', 'queued 3'], 'delivered exactly once, in order');
    assert.equal(await b.page.locator('#messages .message-pending').count(), 0, 'no pending left');
    const onB = (await texts(b.page)).filter(t => /^(queued \d|hello from a)$/.test(t));
    assert.deepEqual(onB, ['hello from a', 'queued 1', 'queued 2', 'queued 3'], 'the sender sees each once, in order');

    // ── The laptop leaves the Wi-Fi (the browser goes offline, server up) ──
    await b.context.setOffline(true);
    await b.page.waitForSelector('#offline-banner', { timeout: 15000 });
    await send(b.page, 'from the train');
    assert.equal(await b.page.locator('#messages .message-pending').count(), 1);
    await b.context.setOffline(false);
    await a.page.waitForFunction(() => document.getElementById('messages').textContent.includes('from the train'), null, { timeout: 30000 });
    await a.page.waitForTimeout(2000);
    assert.equal((await texts(a.page)).filter(t => t === 'from the train').length, 1, 'sent once after the network returns');
  } finally {
    console.log('[browser: external requests blocked]\n' + ([...external].sort().join('\n') || '(none)'));
    let lookups = '';
    try { lookups = [...new Set(fs.readFileSync(path.join(dataDir, 'dns.log'), 'utf8').split('\n').filter(Boolean))].sort().join('\n'); } catch { /* none */ }
    console.log('[server: external name lookups refused]\n' + (lookups || '(none)'));
    await browser.close();
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

'use strict';

// Reading channels from Discord runs as a background job. Held open as one
// request it outlived proxies and tunnels in front of Haven (Cloudflare
// Tunnel answers with an HTML page after 100 seconds), and the page showed
// "Unexpected token '<'". The start request now answers at once with a job
// id, and the page polls for progress and the result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Keep the requires below away from the real data folder.
process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-importjob-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : token === 'other' ? { id: 2 } : null);
const registerImport = require('../src/routes/import');

const routes = {};
const app = {
  post: (p, ...fns) => { routes['POST ' + p] = fns[fns.length - 1]; },
  get: (p, ...fns) => { routes['GET ' + p] = fns[fns.length - 1]; },
};
registerImport({ app, uploadDiskGuard: (q, s, n) => n(), uploadLimiter: (q, s, n) => n(), importUpload: {}, verifyAdminFromDb: () => true });

const call = (key, req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  routes[key](req, res);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A slow Discord: 130 messages in two pages.
let reads = 0;
global.fetch = async (url) => {
  reads++;
  await sleep(150);
  const before = new URL(url).searchParams.get('before');
  const count = before ? 30 : 100;
  const start = before ? 1000 : 2000;
  const batch = Array.from({ length: count }, (_, i) => ({
    id: String(start - i), type: 0, content: `message ${start - i}`, timestamp: new Date(2026, 0, 1).toISOString(),
    author: { id: '99999', username: 'someone' },
  }));
  return new Response(JSON.stringify(batch), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('starting a fetch answers at once with a job, and polling returns the result', async () => {
  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: { discordToken: 'tok', guildName: 'Guild', channels: [{ id: '111111111', name: 'general' }] },
  });
  assert.equal(started.status, 202);
  assert.match(started.body.jobId, /^[0-9a-f]{32}$/);
  assert.equal(started.body.importId, undefined, 'nothing is read before the answer');

  const poll = () => call('GET /api/import/discord/fetch/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
  const first = await poll();
  assert.equal(first.status, 200);
  assert.equal(first.body.state, 'running');

  const stranger = await call('GET /api/import/discord/fetch/:jobId', { headers: { authorization: 'Bearer other' }, params: { jobId: started.body.jobId } });
  assert.equal(stranger.status, 404, 'another admin cannot read this job');

  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await sleep(100);
    const r = await poll();
    if (r.body.state === 'done') done = r;
    else assert.ok(r.body.messages >= 0 && r.body.channelsTotal === 1);
  }
  assert.ok(done, 'the job finishes');
  assert.equal(done.status, 200);
  assert.equal(done.body.totalMessages, 130);
  assert.equal(done.body.channels[0].messageCount, 130);
  assert.ok(reads >= 2);
  fs.rmSync(path.join(os.tmpdir(), `haven-import-${done.body.importId}.json`), { force: true });

  const again = await poll();
  assert.equal(again.status, 404, 'a delivered result is not kept');
});

test('a failed read comes back as the job result', async () => {
  global.fetch = async () => new Response('{}', { status: 401 });
  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: { discordToken: 'tok', channels: [{ id: '222222222', name: 'x' }] },
  });
  assert.equal(started.status, 202);
  await sleep(100);
  const r = await call('GET /api/import/discord/fetch/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Invalid or expired Discord token/);
});

// import.js keeps a cleanup timer running, so end the process once done.
test.after(() => {
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  setImmediate(() => process.exit(0));
});

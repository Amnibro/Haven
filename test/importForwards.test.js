'use strict';

// Importing from Discord (#5811): a forwarded message keeps what was
// forwarded in a snapshot and has no content of its own, so it used to be
// dropped; and bots' escaped punctuation ("3\.1K") came in with the
// backslashes showing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-importfwd-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : null);
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

const author = { id: '99999', username: 'dt64' };
const when = new Date(2026, 4, 16).toISOString();
global.fetch = async () => new Response(JSON.stringify([
  { id: '3', type: 0, content: '', timestamp: when, author,
    message_snapshots: [{ message: { content: 'look at this', attachments: [{ filename: 'cat.png', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png' }] } }] },
  { id: '2', type: 0, content: '', timestamp: when, author, embeds: [{ description: '❤️ 3\\.1K \u{1F441}️ 45\\.5K' }] },
  { id: '1', type: 0, content: 'plain', timestamp: when, author },
]), { status: 200, headers: { 'content-type': 'application/json' } });

test('forwards come in quoted, and escaped punctuation reads as on Discord', async () => {
  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: { discordToken: 'tok', guildName: 'Guild', channels: [{ id: '111111111', name: 'general' }] },
  });
  assert.equal(started.status, 202);
  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await sleep(100);
    const r = await call('GET /api/import/discord/fetch/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
    if (r.body.state === 'done') done = r;
  }
  assert.ok(done, 'the job finishes');
  const file = path.join(os.tmpdir(), `haven-import-${done.body.importId}.json`);
  const messages = JSON.parse(fs.readFileSync(file, 'utf8')).channels[0].messages;
  fs.rmSync(file, { force: true });
  const byId = Object.fromEntries(messages.map(m => [m.discordId, m.content]));
  assert.equal(byId['3'], '> *Forwarded*\n> look at this\n> \u{1F4CE} [cat.png](https://cdn.discordapp.com/attachments/1/2/cat.png)');
  assert.equal(byId['2'], '❤️ 3.1K \u{1F441}️ 45.5K');
  assert.equal(byId['1'], 'plain');
});

// import.js keeps a cleanup timer running, so end the process once done.
test.after(() => {
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  setImmediate(() => process.exit(0));
});

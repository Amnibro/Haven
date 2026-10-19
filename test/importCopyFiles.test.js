'use strict';

// Writing a Discord import copies its attachments into Haven (#5811), unless
// the page turned that off; either way the messages go in.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-importcopy-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : null);
const { initDatabase } = require('../src/database');
const { UPLOADS_DIR } = require('../src/paths');
const db = initDatabase();
db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'admin', 'x', 1)").run();
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

const fetched = [];
global.fetch = async (url) => {
  fetched.push(String(url));
  const body = Buffer.from('meeting notes');
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
};

async function runImport(channelId, name, copyFiles) {
  const importId = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(os.tmpdir(), `haven-import-${importId}.json`), JSON.stringify({ channels: [{
    discordId: channelId, name, topic: '', kind: 'text',
    messages: [{ discordId: channelId + '1', author: 'dt64', timestamp: new Date(2026, 4, 1).toISOString(),
      content: '📎 [notes.txt](https://cdn.discordapp.com/attachments/1/2/notes.txt?ex=1)' }],
  }] }));
  const started = await call('POST /api/import/discord/execute', {
    headers: { authorization: 'Bearer admin' },
    body: { importId, selectedChannels: [{ discordId: channelId, name }], ...(copyFiles === undefined ? {} : { copyFiles }) },
  });
  assert.equal(started.status, 202);
  for (let i = 0; i < 400; i++) {
    const r = await call('GET /api/import/discord/execute/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
    if (r.body.state === 'done') return r.body;
    await sleep(10);
  }
  throw new Error('the import did not finish');
}
const contentIn = (name) => db.prepare('SELECT m.content FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.name = ?').get(name).content;

test('attachments are copied by default', async () => {
  const done = await runImport('700000001', 'copied', undefined);
  assert.equal(done.success, true);
  assert.equal(done.filesCopied, 1);
  const content = contentIn('copied');
  const m = /^\[file:notes\.txt\]\(\/uploads\/([^|)]+)\|13 B\)$/.exec(content);
  assert.ok(m, content);
  assert.equal(fs.readFileSync(path.join(UPLOADS_DIR, m[1]), 'utf8'), 'meeting notes');
});

test('switched off, they stay links and nothing is fetched', async () => {
  fetched.length = 0;
  const done = await runImport('700000002', 'linked', false);
  assert.equal(done.filesCopied, 0);
  assert.match(contentIn('linked'), /^📎 \[notes\.txt\]\(https:\/\/cdn\.discordapp\.com\//u);
  assert.equal(fetched.length, 0);
});

// import.js keeps a cleanup timer running, so end the process once done.
test.after(() => {
  db.close();
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  setImmediate(() => process.exit(0));
});

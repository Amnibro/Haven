'use strict';

// Writing an import runs as a background job. Held open as one request it
// was cut off by proxies in front of Haven (Cloudflare answers 524 after
// about 100 seconds), and as one transaction it froze the server for
// everyone while a large import was written. The start request now answers
// at once with a job id, the page polls for progress and the result, and
// the messages go in a batch per transaction with other requests served in
// between.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Keep the requires below away from the real data folder.
process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-importexec-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : token === 'other' ? { id: 2 } : null);
const { initDatabase } = require('../src/database');
const db = initDatabase();
db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'admin', 'x', 1), (2, 'other', 'x', 1)").run();
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
const start = (importId, selectedChannels, who = 'admin') => call('POST /api/import/discord/execute', {
  headers: { authorization: 'Bearer ' + who }, body: { importId, selectedChannels },
});
const poll = (jobId, who = 'admin') => call('GET /api/import/discord/execute/:jobId', {
  headers: { authorization: 'Bearer ' + who }, params: { jobId },
});
const tempPathFor = (importId) => path.join(os.tmpdir(), `haven-import-${importId}.json`);
const writeImportFile = (data) => {
  const importId = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tempPathFor(importId), JSON.stringify(data));
  return importId;
};
async function waitDone(jobId, seen = []) {
  for (let i = 0; i < 2000; i++) {
    const r = await poll(jobId);
    if (r.body.state === 'done') return r;
    seen.push(r.body);
    await sleep(5);
  }
  throw new Error('the job did not finish');
}

// A Discord server: three chat channels of 6,000 messages each (every tenth
// one a reply to a message two batches back, every 500th pinned, every 100th
// with a reaction), a forum with 20 posts, and a thread in the first channel.
const base = Date.UTC(2024, 0, 1);
const ts = (n) => new Date(base + n * 1000).toISOString();
function bigImport() {
  const channels = [];
  for (let c = 0; c < 3; c++) {
    const messages = [];
    for (let i = 0; i < 6000; i++) {
      messages.push({
        discordId: `${c + 1}${String(i).padStart(7, '0')}`,
        author: `user${i % 7}`,
        content: `channel ${c} message ${i}`,
        timestamp: ts(i),
        isPinned: i % 500 === 0,
        reactions: i % 100 === 0 ? [{ emoji: '👍', count: 2 }] : [],
        replyTo: i % 10 === 5 && i > 2500 ? `${c + 1}${String(i - 2500).padStart(7, '0')}` : null,
      });
    }
    // Reversed, so the write has to put them in order itself.
    channels.push({ discordId: `90000000${c}`, name: `chan-${c}`, topic: '', kind: 'text', messages: messages.reverse() });
  }
  channels.push({ discordId: '900000010', name: 'forum', topic: '', kind: 'forum', tags: ['help'], messages: [] });
  for (let p = 0; p < 20; p++) {
    const postId = `8000000${String(p).padStart(2, '0')}`;
    const messages = [{ discordId: postId, author: 'op', content: `post ${p} opener`, timestamp: ts(p * 100) }];
    for (let r = 1; r <= 49; r++) {
      messages.push({ discordId: `${postId}${String(r).padStart(3, '0')}`, author: 'a', content: `post ${p} reply ${r}`, timestamp: ts(p * 100 + r) });
    }
    channels.push({ discordId: postId, name: `Post ${p}`, kind: 'thread', parentId: '900000010', tags: ['help'], messages });
  }
  const threadMsgs = [];
  for (let r = 0; r < 1000; r++) threadMsgs.push({ discordId: `7000${String(r).padStart(5, '0')}`, author: 't', content: `thread ${r}`, timestamp: ts(r) });
  channels.push({ discordId: '77777777', name: 'side thread', kind: 'thread', parentId: '900000000', messages: threadMsgs });
  return { format: 'Discord Direct', serverName: 'Big', channels };
}
const selectAll = (data) => data.channels.map(c => ({ discordId: c.discordId, originalName: c.name, name: c.name }));

let health;
test.before(async () => {
  // Stands in for Haven's /api/health: answers from the same process and
  // reads the same database, so it waits whenever the write holds the loop.
  health = http.createServer((req, res) => {
    db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get();
    res.end('{"status":"online"}');
  });
  await new Promise(r => health.listen(0, '127.0.0.1', r));
});

const timedHealth = () => new Promise((resolve, reject) => {
  const t0 = process.hrtime.bigint();
  http.get({ host: '127.0.0.1', port: health.address().port, path: '/api/health' }, (res) => {
    res.resume();
    res.on('end', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
  }).on('error', reject);
});

test('a large import is written as a job, in order, with replies, threads and pins, while the server keeps answering', async () => {
  const data = bigImport();
  const total = data.channels.reduce((n, c) => n + c.messages.length, 0);
  assert.equal(total, 3 * 6000 + 20 * 50 + 1000);
  const importId = writeImportFile(data);

  const t0 = Date.now();
  const started = await start(importId, selectAll(data));
  assert.equal(started.status, 202);
  assert.match(started.body.jobId, /^[0-9a-f]{32}$/);
  assert.equal(started.body.messagesImported, undefined, 'nothing is written before the answer');

  const stranger = await poll(started.body.jobId, 'other');
  assert.equal(stranger.status, 404, 'another admin cannot read this job');

  const otherId = writeImportFile({ channels: [] });
  const busy = await start(otherId, [{ originalName: 'x' }]);
  assert.equal(busy.status, 429, 'one import is written at a time');
  fs.rmSync(tempPathFor(otherId), { force: true });

  // Health checks run back to back for as long as the write takes.
  const latencies = [];
  let writing = true;
  const pinger = (async () => {
    while (writing) latencies.push(await timedHealth());
  })();
  const seen = [];
  const done = await waitDone(started.body.jobId, seen);
  const elapsed = Date.now() - t0;
  writing = false;
  await pinger;

  assert.equal(done.status, 200);
  assert.equal(done.body.success, true);
  assert.equal(done.body.channelsCreated, 4);
  assert.equal(done.body.threadsImported, 21);
  assert.equal(done.body.messagesImported, total);
  assert.equal(done.body.messagesSkipped, 0);
  assert.ok(seen.some(s => s.state === 'running' && s.messagesTotal === total && s.messagesDone > 0 && s.messagesDone < total),
    'progress is reported while the messages go in');
  assert.ok(!fs.existsSync(tempPathFor(importId)), 'the import file is removed at the end');
  assert.equal((await poll(started.body.jobId)).status, 404, 'a delivered result is not kept');

  const maxLatency = Math.max(...latencies);
  console.log(`[importExecuteJob] wrote ${total} messages in ${elapsed} ms; ${latencies.length} health checks, slowest ${maxLatency.toFixed(1)} ms`);
  assert.ok(latencies.length >= 5, 'health checks were answered during the write');
  assert.ok(maxLatency < 1000, `a health check waited ${maxLatency} ms`);
  // Requests get in between batches, not only between channels: progress
  // polls land partway through the first channel's 6,000 messages.
  const midFirstChannel = new Set(seen.filter(s => s.messagesDone > 0 && s.messagesDone < 6000).map(s => s.messagesDone));
  assert.ok(midFirstChannel.size >= 3, `polls saw ${midFirstChannel.size} points inside the first channel`);

  // Order: in every channel, ids follow the Discord timestamps.
  const chan0 = db.prepare("SELECT id FROM channels WHERE discord_channel_id = '900000000'").get().id;
  const rows = db.prepare('SELECT id, content, created_at, reply_to, discord_message_id FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id').all(chan0);
  assert.equal(rows.length, 6000 + 1, 'the channel holds its messages and the side thread root');
  const own = rows.filter(r => r.discord_message_id !== '77777777');
  own.forEach((r, i) => assert.equal(r.content, `channel 0 message ${i}`));

  // Replies reach messages written two batches earlier.
  const byDiscord = new Map(own.map(r => [r.discord_message_id, r.id]));
  const reply = own[5005];
  assert.equal(reply.reply_to, byDiscord.get('10002505'));
  assert.equal(own.filter(r => r.reply_to).length, 350);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pinned_messages WHERE channel_id = ?').get(chan0).n, 12);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions r JOIN messages m ON m.id = r.message_id WHERE m.channel_id = ?').get(chan0).n, 60);

  // The side thread hangs from a line in its channel.
  const root = db.prepare("SELECT id, content FROM messages WHERE channel_id = ? AND discord_message_id = '77777777'").get(chan0);
  assert.match(root.content, /side thread/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(root.id).n, 1000);

  // Forum posts are topics with their replies.
  const forum = db.prepare("SELECT id, is_forum FROM channels WHERE discord_channel_id = '900000010'").get();
  assert.equal(forum.is_forum, 1);
  const topics = db.prepare('SELECT id, title FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id').all(forum.id);
  assert.equal(topics.length, 20);
  assert.equal(topics[0].title, 'Post 0');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(topics[0].id).n, 49);

  // Importing the same file again adds nothing.
  const againId = writeImportFile(data);
  const again = await waitDone((await start(againId, selectAll(data))).body.jobId);
  assert.equal(again.status, 200);
  assert.equal(again.body.channelsCreated, 0);
  assert.equal(again.body.channelsReused, 4);
  assert.equal(again.body.messagesImported, 0);
  assert.equal(again.body.messagesSkipped, 18000 + 20 * 49 + 1000);
});

test('an import that fails halfway ends as a failure that says how much got in, and running it again finishes it', async () => {
  const messages = [];
  for (let i = 0; i < 2500; i++) messages.push({ discordId: `5${String(i).padStart(7, '0')}`, author: 'x', content: `m ${i}`, timestamp: ts(i) });
  // A message the write cannot handle, in the third batch.
  messages[2200].content = 12345;
  const data = { channels: [{ discordId: '600000000', name: 'broken', kind: 'text', messages }] };
  const importId = writeImportFile(data);
  const done = await waitDone((await start(importId, selectAll(data))).body.jobId);
  assert.equal(done.status, 500);
  assert.match(done.body.error, /^Import failed: /);
  assert.equal(done.body.messagesImported, 2000, 'the two finished batches are counted, the rolled back one is not');
  const channelId = db.prepare("SELECT id FROM channels WHERE discord_channel_id = '600000000'").get().id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId).n, 2000);
  assert.ok(fs.existsSync(tempPathFor(importId)), 'the import file is kept for another try');

  // Once the bad message is fixed, the same import finishes the rest.
  messages[2200].content = 'm 2200';
  fs.writeFileSync(tempPathFor(importId), JSON.stringify(data));
  const retry = await waitDone((await start(importId, selectAll(data))).body.jobId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.channelsReused, 1);
  assert.equal(retry.body.messagesSkipped, 2000);
  assert.equal(retry.body.messagesImported, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId).n, 2500);
});

test('bad requests are answered at once', async () => {
  assert.equal((await start('nothex', [{ originalName: 'x' }])).status, 400);
  assert.equal((await start(crypto.randomBytes(16).toString('hex'), [{ originalName: 'x' }])).status, 404);
  assert.equal((await start(crypto.randomBytes(16).toString('hex'), [])).status, 400);
  assert.equal((await poll('0'.repeat(32))).status, 404);
});

// import.js keeps a cleanup timer running, so end the process once done.
test.after(() => {
  health.close();
  db.close();
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  setImmediate(() => process.exit(0));
});

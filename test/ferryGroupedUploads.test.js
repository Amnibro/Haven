'use strict';

// Pictures sent together are one Haven message (#5799), and Ferry relays that
// message's own pictures to Discord together, as one message with the files
// attached, up to Discord's ten.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-ferry-group-'));
process.env.HAVEN_DATA_DIR = DATA;
const Database = require('better-sqlite3');
const ferry = require('../src/ferry');
const { UPLOADS_DIR } = require('../src/paths');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE ferry_links (webhook_id TEXT);
  CREATE TABLE upload_ownership (rel_path TEXT PRIMARY KEY, user_id INTEGER, scope TEXT);
`);
ferry.initFerry({ db, sanitizeText: (s) => s });

const names = Array.from({ length: 12 }, (_, i) => `1760000000000-${String(i).padStart(8, '0')}.png`);
for (const n of names) {
  fs.writeFileSync(path.join(UPLOADS_DIR, n), Buffer.from('png'));
  db.prepare('INSERT INTO upload_ownership (rel_path, user_id, scope) VALUES (?, ?, ?)').run(n, 7, 'channel');
}
const sender = { id: 7, isAdmin: false };

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('a grouped message relays its text and every picture in one go', () => {
  const content = ['Weekend', `/uploads/${names[0]}`, `spoiler-img:/uploads/${names[1]}`, `/uploads/${names[2]}`].join('\n');
  const { text, files } = ferry.takeUploads(content, sender);
  assert.equal(text, 'Weekend');
  assert.equal(files.length, 3);
  assert.ok(files[1].name.startsWith('SPOILER_'), 'a spoiler picture stays a spoiler on Discord');
});

test('ten pictures fit one Discord message', () => {
  const content = names.slice(0, 10).map((n) => `/uploads/${n}`).join('\n');
  const { text, files } = ferry.takeUploads(content, sender);
  assert.equal(files.length, 10);
  assert.equal(text, '');
});

test('only the sender\'s own pictures go', () => {
  const content = [`/uploads/${names[3]}`, `/uploads/${names[11]}`].join('\n');
  // Someone else's upload, named in this sender's message.
  db.prepare('UPDATE upload_ownership SET user_id = 8 WHERE rel_path = ?').run(names[11]);
  const { files } = ferry.takeUploads(content, sender);
  assert.equal(files.length, 1);
});

test('a video sent as a spoiler goes to Discord as a spoiler', () => {
  const clip = '1760000000000-clip0001.mp4';
  fs.writeFileSync(path.join(UPLOADS_DIR, clip), Buffer.from('mp4'));
  db.prepare('INSERT INTO upload_ownership (rel_path, user_id, scope) VALUES (?, ?, ?)').run(clip, 7, 'channel');
  const { text, files } = ferry.takeUploads(`ending spoilers
spoiler-img:[file:finale.mp4](/uploads/${clip}|3 B)`, sender);
  assert.equal(text, 'ending spoilers', 'no stray mark left in the text');
  assert.equal(files.length, 1);
  assert.ok(files[0].name.startsWith('SPOILER_'));
});

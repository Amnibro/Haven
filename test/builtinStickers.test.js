'use strict';

// Built-in sticker packs (src/builtinStickers.js): seeding a new server,
// upgrading one that has the old "Starter" pack, respecting what admins
// deleted, uploaded or edited, the per-pack switch, and the PNG that apps
// which cannot draw SVG are sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const express = require('express');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-builtin-stickers-'));
process.env.HAVEN_DATA_DIR = path.join(ROOT, 'data');
const { initDatabase } = require('../src/database');
const { createBuiltinStickers, loadManifest, wantsRaster, STARTER_SHA256 } = require('../src/builtinStickers');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const pristine = path.join(ROOT, 'pristine.db');
initDatabase().exec(`VACUUM INTO '${pristine.replace(/'/g, "''")}'`);

// A server of its own: a fresh copy of the schema and an empty sticker folder.
let n = 0;
function server(assetsDir) {
  const dir = path.join(ROOT, `s${++n}`);
  fs.mkdirSync(path.join(dir, 'stickers'), { recursive: true });
  fs.copyFileSync(pristine, path.join(dir, 'haven.db'));
  const db = new Database(path.join(dir, 'haven.db'));
  const stickersDir = path.join(dir, 'stickers');
  const make = () => createBuiltinStickers({ stickersDir, getDb: () => db, assetsDir, log: { log() {}, warn() {} } });
  return { db, stickersDir, b: make(), make };
}
const rows = (db) => db.prepare('SELECT name, pack_name, filename, uploaded_by, builtin_id FROM stickers ORDER BY name').all();
const row = (db, name) => db.prepare('SELECT * FROM stickers WHERE name = ?').get(name);

// The Starter pack exactly as #5335 shipped it: a coloured disc with an
// emoji character on top.
const STARTER = { check: ['#33c659', 58, 120, '✅'], eyes: ['#2bb1d4', 56, 110, '👀'], fire: ['#ff7a1a', 56, 120, '🔥'], heart: ['#ff5b6e', 56, 120, '❤️'],
  laugh: ['#ffb627', 56, 120, '😂'], nope: ['#e63946', 58, 120, '❌'], party: ['#a259ff', 56, 110, '🎉'], 'thumbs-up': ['#1d9bf0', 56, 120, '👍'] };
const starterSvg = (name) => {
  const [fill, y, size, ch] = STARTER[name];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><circle cx="100" cy="100" r="92" fill="${fill}" stroke="#fff" stroke-width="6"/><text x="50%" y="${y}%" font-size="${size}" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji,sans-serif" dominant-baseline="middle">${ch}</text></svg>\n`;
};
// What an older Haven left behind after seeding its Starter pack.
function seedStarter(s, skip = []) {
  for (const name of Object.keys(STARTER)) {
    if (skip.includes(name)) continue;
    fs.writeFileSync(path.join(s.stickersDir, `starter-${name}.svg`), starterSvg(name));
    s.db.prepare("INSERT INTO stickers (name, pack_name, filename, uploaded_by) VALUES (?, 'Starter', ?, NULL)").run(name, `starter-${name}.svg`);
  }
}

const packs = loadManifest();
const all = packs.flatMap((p) => p.stickers);

test('the shipped packs are complete and every sticker has its PNG', () => {
  assert.deepEqual(packs.map((p) => p.id), ['reactions', 'haven', 'gaming']);
  assert.ok(all.length >= 40 && all.length <= 60, `${all.length} stickers`);
  assert.equal(new Set(all.map((s) => s.name)).size, all.length, 'names are unique');
  for (const s of all) {
    assert.ok(s.png, `${s.builtinId} has a PNG`);
    assert.ok(s.keywords.length, `${s.builtinId} has keywords`);
    const svg = fs.readFileSync(s.svg, 'utf8');
    assert.doesNotMatch(svg, /<text|<image|<script|<foreignObject|font-family|filter=|href="http/i, `${s.builtinId} is self-contained vector art`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="0 0 256 256"/);
  }
  for (const p of packs) assert.ok(p.stickers.some((s) => s.name === p.icon), `${p.id} has its icon sticker`);
  for (const name of Object.keys(STARTER)) assert.ok(all.some((s) => s.legacy.includes(name)), `a built-in replaces Starter ${name}`);
});

test('the Starter hashes match the files older versions seeded', () => {
  for (const name of Object.keys(STARTER)) assert.equal(sha(starterSvg(name)), STARTER_SHA256[name], name);
});

test('a new server gets every pack; a second start changes nothing', () => {
  const s = server();
  const r = s.b.sync();
  assert.equal(r.added.length, all.length);
  const list = rows(s.db);
  assert.equal(list.length, all.length);
  for (const x of list) {
    assert.equal(x.uploaded_by, null);
    assert.match(x.filename, /^builtin-[a-z]+-[a-z0-9-]+\.svg$/);
    assert.ok(fs.existsSync(path.join(s.stickersDir, x.filename)));
  }
  assert.equal(row(s.db, 'heart').pack_name, 'Reactions');
  assert.equal(row(s.db, 'hello').pack_name, 'Haven');
  const again = s.make().sync();
  assert.deepEqual([again.added, again.adopted, again.updated, again.skipped, again.forgotten], [[], [], [], [], []]);
  assert.equal(rows(s.db).length, all.length);
});

test('a server with the old Starter pack keeps its file names and gets the new drawings', () => {
  const s = server();
  seedStarter(s);
  const r = s.b.sync();
  assert.equal(r.adopted.length, 8);
  assert.equal(r.added.length, all.length - 8);
  for (const name of Object.keys(STARTER)) {
    const x = row(s.db, name);
    assert.equal(x.filename, `starter-${name}.svg`, 'old messages point at this file');
    assert.equal(x.pack_name, 'Reactions');
    assert.ok(x.builtin_id);
    const now = fs.readFileSync(path.join(s.stickersDir, x.filename), 'utf8');
    assert.notEqual(sha(now), STARTER_SHA256[name]);
    assert.doesNotMatch(now, /<text/);
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) AS c FROM stickers WHERE pack_name = 'Starter'").get().c, 0);
});

test('a Starter sticker an admin edited or deleted is left as the admin left it', () => {
  const s = server();
  seedStarter(s, ['eyes']);
  fs.writeFileSync(path.join(s.stickersDir, 'starter-fire.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
  const r = s.b.sync();
  assert.deepEqual(r.skipped.sort(), ['eyes', 'fire']);
  assert.equal(row(s.db, 'eyes'), undefined, 'a deleted Starter sticker does not come back');
  const fire = row(s.db, 'fire');
  assert.equal(fire.pack_name, 'Starter');
  assert.equal(fire.builtin_id, null);
  assert.match(fs.readFileSync(path.join(s.stickersDir, 'starter-fire.svg'), 'utf8'), /r="5"/);
  assert.equal(s.make().sync().added.length, 0, 'and still not on the next start');
});

test('stickers an admin uploaded are never touched, even with a built-in name', () => {
  const s = server();
  const admin = s.db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('owner', 'x', 1)").run().lastInsertRowid;
  s.db.prepare("INSERT INTO stickers (name, pack_name, filename, uploaded_by) VALUES ('wave', 'Mine', 'my-wave.png', ?)").run(admin);
  s.db.prepare("INSERT INTO stickers (name, pack_name, filename, uploaded_by) VALUES ('cat', 'Mine', 'cat.png', ?)").run(admin);
  const r = s.b.sync();
  assert.deepEqual(r.skipped, ['wave']);
  assert.deepEqual(row(s.db, 'wave'), { ...row(s.db, 'wave'), pack_name: 'Mine', filename: 'my-wave.png', uploaded_by: admin, builtin_id: null });
  assert.equal(row(s.db, 'cat').filename, 'cat.png');
  assert.equal(rows(s.db).length, all.length + 1);
  assert.equal(s.b.packStates().find((p) => p.id === 'reactions').missing, 0, 'nothing to restore while the name is taken');
});

test('a deleted built-in stays deleted; its file stays for old messages; restore brings it back', () => {
  const s = server();
  s.b.sync();
  const heart = row(s.db, 'heart');
  assert.equal(s.b.noteDeleted(heart), true);
  s.db.prepare('DELETE FROM stickers WHERE name = ?').run('heart');
  assert.ok(fs.existsSync(path.join(s.stickersDir, heart.filename)));
  assert.equal(s.make().sync().added.length, 0);
  assert.equal(row(s.db, 'heart'), undefined);
  assert.equal(s.b.packStates().find((p) => p.id === 'reactions').missing, 1);
  assert.deepEqual(s.b.restorePack('reactions'), ['heart']);
  assert.equal(row(s.db, 'heart').filename, heart.filename);
  assert.equal(s.b.restorePack('nope-not-a-pack'), null);
  assert.equal(s.b.noteDeleted({ filename: 'x.png', builtin_id: null }), false, 'uploads are not built-ins');
});

test('a built-in replaced by an upload under its name is not fought over', () => {
  const s = server();
  s.b.sync();
  s.db.prepare("INSERT OR REPLACE INTO stickers (name, pack_name, filename, uploaded_by) VALUES ('fire', 'Mine', 'my-fire.gif', NULL)").run();
  const r = s.make().sync();
  assert.deepEqual(r.forgotten, ['fire']);
  assert.equal(row(s.db, 'fire').filename, 'my-fire.gif');
});

test('a changed drawing replaces the copy Haven wrote, never an edited one', () => {
  const assets = path.join(ROOT, 'assets-v2');
  fs.cpSync(path.join(__dirname, '..', 'public', 'stickers'), assets, { recursive: true });
  const s = server(assets);
  s.b.sync();
  const fire = row(s.db, 'fire');
  const check = row(s.db, 'check');
  fs.appendFileSync(path.join(s.stickersDir, check.filename), '<!-- edited by the admin -->');
  for (const name of ['fire', 'check']) fs.appendFileSync(path.join(assets, 'reactions', `${name}.svg`), '<!-- v2 -->');
  const r = s.make().sync();
  assert.deepEqual(r.updated, ['fire']);
  assert.match(fs.readFileSync(path.join(s.stickersDir, fire.filename), 'utf8'), /v2/);
  assert.match(fs.readFileSync(path.join(s.stickersDir, check.filename), 'utf8'), /edited by the admin/);
});

test('switching a pack off hides it from the list but keeps it on disk', () => {
  const s = server();
  s.b.sync();
  assert.equal(s.b.setPackEnabled('gaming', false), true);
  assert.equal(s.b.setPackEnabled('unknown', false), false);
  const off = s.b.disabledPacks();
  assert.deepEqual([...off], ['gaming']);
  assert.equal(s.b.describe(row(s.db, 'trophy'), off).visible, false);
  const heart = s.b.describe(row(s.db, 'heart'), off);
  assert.equal(heart.visible, true);
  assert.equal(heart.extra.builtin, 'reactions');
  assert.ok(heart.extra.keywords.includes('love'));
  assert.equal(heart.extra.animated, true);
  assert.deepEqual(s.b.describe({ builtin_id: null }, off), { visible: true, extra: {}, order: Infinity });
  assert.ok(s.b.describe(row(s.db, 'thumbs-up'), off).order < s.b.describe(row(s.db, 'heart'), off).order, 'drawn order, not alphabetical');
  const gaming = s.b.packStates().find((p) => p.id === 'gaming');
  assert.equal(gaming.enabled, false);
  assert.match(gaming.icon, /^\/uploads\/stickers\/builtin-gaming-controller\.svg$/);
  assert.ok(fs.existsSync(path.join(s.stickersDir, row(s.db, 'trophy').filename)));
});

test('only clients that cannot draw SVG are sent the PNG', () => {
  const req = (accept, query = {}) => ({ headers: accept === undefined ? {} : { accept }, query });
  assert.equal(wantsRaster(req('image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8')), false, 'Chrome');
  assert.equal(wantsRaster(req('image/webp,image/avif,image/jxl,image/heic,image/heic-sequence,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.5,*/*;q=0.2')), false, 'Safari');
  assert.equal(wantsRaster(req('image/*,*/*;q=0.8')), true, 'SDWebImage (Haven for iOS)');
  assert.equal(wantsRaster(req(undefined)), false, 'Glide (Haven for Android)');
  assert.equal(wantsRaster(req('*/*')), false, 'curl');
  assert.equal(wantsRaster(req('*/*', { format: 'png' })), true);
  assert.equal(wantsRaster(req('image/*', { format: 'svg' })), false);
});

test('the uploads route serves SVG or PNG for built-ins and leaves other files alone', async (t) => {
  const s = server();
  seedStarter(s);
  s.b.sync();
  fs.writeFileSync(path.join(s.stickersDir, 'upload.png'), 'not really a png');
  const app = express();
  app.use('/uploads/stickers', s.b.serve);
  app.use('/uploads/stickers', (req, res) => res.status(299).end());
  const srv = app.listen(0);
  t.after(() => srv.close());
  const get = (p, accept) => new Promise((resolve, reject) => {
    http.get({ port: srv.address().port, path: p, headers: accept ? { accept } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const svg = await get('/uploads/stickers/starter-fire.svg', 'image/svg+xml,image/*');
  assert.equal(svg.status, 200);
  assert.match(svg.headers['content-type'], /image\/svg\+xml/);
  assert.match(svg.headers.vary, /Accept/);
  assert.match(svg.headers['cache-control'], /private/);
  assert.match(svg.headers['content-security-policy'], /sandbox/);
  assert.match(svg.body.toString(), /^<svg/);
  const png = await get('/uploads/stickers/starter-fire.svg', 'image/*,*/*;q=0.8');
  assert.equal(png.status, 200);
  assert.match(png.headers['content-type'], /image\/png/);
  assert.deepEqual([...png.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await get('/uploads/stickers/upload.png', 'image/*')).status, 299, 'uploads go on to the static handler');
  assert.equal((await get('/uploads/stickers/..%2fhaven.db', 'image/*')).status, 299);
  // An admin's hand edit is served as-is: no PNG of the old drawing.
  fs.appendFileSync(path.join(s.stickersDir, 'starter-heart.svg'), '<!-- edited -->');
  s.b.refreshServed();
  assert.equal((await get('/uploads/stickers/starter-heart.svg', 'image/*')).status, 299);
});

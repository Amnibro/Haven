'use strict';

// Built-in sticker packs: the drawings in public/stickers/ (made by
// tools/stickers/build.js) that every Haven server offers out of the box.
//
// They live in the same `stickers` table and uploads/stickers/ folder as the
// stickers admins upload, so sending, the :name: shortcode and message
// rendering work the same way for both. On every start, sync():
//   - adds built-ins this server has not seen yet, including new ones that
//     arrive with an update, not only on an empty server;
//   - never adds back one an admin deleted, and never touches a sticker an
//     admin uploaded (a built-in whose name is already taken is skipped);
//   - adopts the eight "Starter" stickers older versions seeded, swapping in
//     the new drawing at the same file name so old messages that show them
//     keep working and look better, unless an admin edited the file;
//   - updates a built-in's file when its drawing changes, again only if the
//     copy on disk is still the one Haven wrote.
//
// Each sticker also ships as a PNG for apps that cannot draw SVG. serve() sends
// it to a client that asks for images without listing SVG (Haven for iOS), so
// app versions already in the stores show built-ins without an update.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STICKER_ASSETS = path.join(ROOT, 'public', 'stickers');

// The Starter pack files from #5335, by name, so an untouched copy can be told
// apart from one an admin replaced by hand.
const STARTER_SHA256 = {
  check: 'b98295afe6cda1f61ddd30d9a2f6295de7b2c27a5b8d13f8db1afd9157104c53',
  eyes: 'd24ee0b0e89167933f4549d02482cf734fb4833936ab97dbe39b3bc90c84ca7e',
  fire: 'ec609c4a9dba2af612ee62db560208b0b7fe3539c08dd73fac33645af5afaad1',
  heart: '16861e2e9cccfe776127b6be6bc7382d162314b0f60f4643d0ffbcb5569116ca',
  laugh: '13d0fc7e14e5d4c04b95a9906e6a1d37ce6bb128db1d6eae58e9f9b72e351b0d',
  nope: 'b06fdcf82e702b425aaafbc70e44ceef25e425ac0fbc64d66921d40ea2d45d0f',
  party: '0de829ef04032b068174f9ceba75e9fae98eb26de787a3823a51b3d31a5075a1',
  'thumbs-up': 'bc5891a948ca938c1d63631f60619b1bfc8d254e5797974e6e9020a8e4b94592',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function fileSha(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

// packs.json, flattened. Returns [] when the assets are missing so a trimmed
// install still starts.
function loadManifest(assetsDir = STICKER_ASSETS) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'packs.json'), 'utf8')); } catch { return []; }
  const packs = [];
  for (const p of manifest.packs || []) {
    if (!/^[a-z0-9-]{1,32}$/.test(p.id)) continue;
    const stickers = [];
    for (const s of p.stickers || []) {
      if (!/^[a-z0-9_-]{1,40}$/.test(s.id)) continue;
      const svg = path.join(assetsDir, p.id, `${s.id}.svg`);
      if (!fs.existsSync(svg)) continue;
      const png = path.join(assetsDir, p.id, `${s.id}.png`);
      stickers.push({
        builtinId: `${p.id}/${s.id}`,
        packId: p.id,
        packName: p.name,
        name: s.name || s.id,
        keywords: Array.isArray(s.keywords) ? s.keywords.map(String) : [],
        animated: !!s.animated,
        legacy: Array.isArray(s.legacy) ? s.legacy : [],
        svg,
        png: fs.existsSync(png) ? png : null,
        sha256: fileSha(svg),
      });
    }
    packs.push({ id: p.id, name: p.name, icon: p.icon, stickers });
  }
  return packs;
}

// What the client asked for: a PNG when it says so (?format=png), or when it
// accepts images but does not list SVG. Browsers list image/svg+xml for
// <img>; SDWebImage (Haven for iOS) sends "image/*,*/*;q=0.8"; Glide on
// Android sends no Accept at all and draws the SVG itself.
function wantsRaster(req) {
  if (req.query && req.query.format === 'png') return true;
  if (req.query && req.query.format === 'svg') return false;
  const accept = String(req.headers.accept || '');
  return /image\//i.test(accept) && !/svg/i.test(accept);
}

function createBuiltinStickers({ stickersDir, getDb, assetsDir = STICKER_ASSETS, log = console }) {
  const packs = loadManifest(assetsDir);
  const byId = new Map(packs.flatMap((p) => p.stickers.map((s) => [s.builtinId, s])));
  const order = new Map([...byId.keys()].map((id, i) => [id, i]));
  // uploads/stickers file name -> built-in, for rows that are built-ins and
  // whose file is still the drawing Haven wrote (only those get the PNG).
  let served = new Map();

  const db = () => (getDb || require('./database').getDb)();
  const fileFor = (s) => `builtin-${s.packId}-${s.name}.svg`;

  function writeCopy(s, filename) {
    fs.mkdirSync(stickersDir, { recursive: true });
    const tmp = path.join(stickersDir, `.${filename}.${process.pid}.tmp`);
    fs.copyFileSync(s.svg, tmp);
    fs.renameSync(tmp, path.join(stickersDir, filename));
    return s.sha256;
  }

  function refreshServed() {
    const next = new Map();
    for (const row of db().prepare('SELECT filename, builtin_id FROM stickers WHERE builtin_id IS NOT NULL').all()) {
      const s = byId.get(row.builtin_id);
      if (s && s.png && fileSha(path.join(stickersDir, row.filename)) === s.sha256) next.set(row.filename, s);
    }
    served = next;
  }

  function sync() {
    const summary = { added: [], adopted: [], updated: [], skipped: [], forgotten: [] };
    if (!packs.length) return summary;
    const d = db();
    const states = new Map(d.prepare('SELECT builtin_id, sha256, deleted FROM builtin_stickers').all().map((r) => [r.builtin_id, r]));
    // The first sync on a server is the only time a missing Starter sticker
    // can be read as "an admin deleted it": the pack was seeded whole, so a
    // gap means a deletion. Later, a missing row is handled through states.
    const firstSync = states.size === 0;
    const rows = d.prepare('SELECT id, name, pack_name, filename, uploaded_by, builtin_id FROM stickers').all();
    const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
    const byBuiltin = new Map(rows.filter((r) => r.builtin_id).map((r) => [r.builtin_id, r]));
    const starterRow = (name) => {
      const r = byName.get(name);
      return r && !r.builtin_id && r.uploaded_by == null && r.pack_name === 'Starter' && r.filename === `starter-${name}.svg` ? r : null;
    };
    const seededStarter = rows.some((r) => !r.builtin_id && r.uploaded_by == null && r.pack_name === 'Starter' && /^starter-/.test(r.filename));

    const setState = d.prepare(`INSERT INTO builtin_stickers (builtin_id, pack_id, sha256, deleted, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(builtin_id) DO UPDATE SET pack_id = excluded.pack_id, sha256 = excluded.sha256, deleted = excluded.deleted, updated_at = CURRENT_TIMESTAMP`);
    const insertRow = d.prepare('INSERT INTO stickers (name, pack_name, filename, uploaded_by, builtin_id) VALUES (?, ?, ?, NULL, ?)');
    const adoptRow = d.prepare('UPDATE stickers SET pack_name = ?, builtin_id = ? WHERE id = ?');

    const run = d.transaction(() => {
      for (const p of packs) d.prepare('INSERT OR IGNORE INTO builtin_sticker_packs (pack_id, enabled) VALUES (?, 1)').run(p.id);
      for (const s of byId.values()) {
        const st = states.get(s.builtinId);
        if (st && st.deleted) continue;
        const row = byBuiltin.get(s.builtinId);
        if (row) {
          // Known and present: bring a changed drawing in, but only over the
          // copy Haven wrote. An edited file stays, and keeps its own hash.
          const file = path.join(stickersDir, row.filename);
          const onDisk = fileSha(file);
          if (onDisk !== s.sha256 && (onDisk === null || onDisk === st?.sha256)) {
            setState.run(s.builtinId, s.packId, writeCopy(s, row.filename), 0);
            summary.updated.push(s.name);
          } else if (!st) {
            setState.run(s.builtinId, s.packId, onDisk, 0);
          }
          continue;
        }
        if (st) {
          // Seen before but its row is gone: removed some way other than the
          // delete route (an upload under the same name, a template import).
          setState.run(s.builtinId, s.packId, st.sha256, 1);
          summary.forgotten.push(s.name);
          continue;
        }
        // New to this server. A Starter sticker it replaces is adopted in place.
        const legacyName = s.legacy.find((n) => starterRow(n));
        if (legacyName) {
          const r = starterRow(legacyName);
          const onDisk = fileSha(path.join(stickersDir, r.filename));
          if (onDisk === null || onDisk === STARTER_SHA256[legacyName] || onDisk === s.sha256) {
            const sha = writeCopy(s, r.filename);
            adoptRow.run(s.packName, s.builtinId, r.id);
            setState.run(s.builtinId, s.packId, sha, 0);
            r.builtin_id = s.builtinId;
            summary.adopted.push(s.name);
            continue;
          }
        }
        const taken = byName.get(s.name.toLowerCase());
        const deletedStarter = firstSync && seededStarter && s.legacy.length && !taken;
        if (taken || deletedStarter) {
          setState.run(s.builtinId, s.packId, null, 1);
          summary.skipped.push(s.name);
          continue;
        }
        const filename = fileFor(s);
        const sha = writeCopy(s, filename);
        const id = insertRow.run(s.name, s.packName, filename, s.builtinId).lastInsertRowid;
        byName.set(s.name.toLowerCase(), { id, name: s.name, builtin_id: s.builtinId });
        setState.run(s.builtinId, s.packId, sha, 0);
        summary.added.push(s.name);
      }
    });
    run();
    refreshServed();
    return summary;
  }

  function syncAndLog() {
    try {
      const r = sync();
      const parts = [['added', r.added], ['upgraded from the Starter pack', r.adopted], ['updated', r.updated]]
        .filter(([, list]) => list.length).map(([what, list]) => `${list.length} ${what}`);
      if (parts.length) log.log(`[stickers] Built-in stickers: ${parts.join(', ')}.`);
      return r;
    } catch (err) {
      // Non-fatal: the server runs fine without built-in stickers.
      log.warn('[stickers] Could not set up the built-in stickers:', err?.message || err);
      return null;
    }
  }

  function packStates() {
    const d = db();
    const enabled = new Map(d.prepare('SELECT pack_id, enabled FROM builtin_sticker_packs').all().map((r) => [r.pack_id, !!r.enabled]));
    const deleted = new Set(d.prepare('SELECT builtin_id FROM builtin_stickers WHERE deleted = 1').all().map((r) => r.builtin_id));
    const present = new Map(d.prepare('SELECT builtin_id, filename FROM stickers WHERE builtin_id IS NOT NULL').all().map((r) => [r.builtin_id, r.filename]));
    // Only deletions that a restore could undo: a name an uploaded sticker
    // took meanwhile stays with that sticker.
    const names = new Set(d.prepare('SELECT name FROM stickers').all().map((r) => r.name.toLowerCase()));
    return packs.map((p) => {
      const icon = p.stickers.find((s) => s.name === p.icon && present.has(s.builtinId)) || p.stickers.find((s) => present.has(s.builtinId));
      return {
        id: p.id,
        name: p.name,
        enabled: enabled.get(p.id) !== false,
        total: p.stickers.length,
        count: p.stickers.filter((s) => present.has(s.builtinId)).length,
        missing: p.stickers.filter((s) => deleted.has(s.builtinId) && !names.has(s.name.toLowerCase())).length,
        icon: icon ? `/uploads/stickers/${present.get(icon.builtinId)}` : null,
      };
    });
  }

  function setPackEnabled(packId, enabled) {
    if (!packs.some((p) => p.id === packId)) return false;
    db().prepare('INSERT INTO builtin_sticker_packs (pack_id, enabled) VALUES (?, ?) ON CONFLICT(pack_id) DO UPDATE SET enabled = excluded.enabled').run(packId, enabled ? 1 : 0);
    return true;
  }

  // Bring back every built-in of a pack an admin deleted, where the name is
  // free again. Returns the names added, or null for an unknown pack.
  function restorePack(packId) {
    if (!packs.some((p) => p.id === packId)) return null;
    db().prepare('DELETE FROM builtin_stickers WHERE pack_id = ? AND deleted = 1').run(packId);
    return sync().added;
  }

  // Called by the delete route before the row goes: remembers the deletion.
  // Returns true when the row is a built-in, whose file is kept so messages
  // that already show it keep working.
  function noteDeleted(row) {
    if (!row || !row.builtin_id || !byId.has(row.builtin_id)) return false;
    const s = byId.get(row.builtin_id);
    db().prepare(`INSERT INTO builtin_stickers (builtin_id, pack_id, sha256, deleted) VALUES (?, ?, NULL, 1)
      ON CONFLICT(builtin_id) DO UPDATE SET deleted = 1, updated_at = CURRENT_TIMESTAMP`).run(s.builtinId, s.packId);
    served.delete(row.filename);
    return true;
  }

  // Extra fields for /api/stickers, and whether the row should be listed.
  function describe(row, disabledPacks) {
    const s = row.builtin_id && byId.get(row.builtin_id);
    if (!s) return { visible: true, extra: {}, order: Infinity };
    return { visible: !disabledPacks.has(s.packId), order: order.get(s.builtinId), extra: { builtin: s.packId, keywords: s.keywords, ...(s.animated ? { animated: true } : {}) } };
  }
  const disabledPacks = () => new Set(db().prepare('SELECT pack_id FROM builtin_sticker_packs WHERE enabled = 0').all().map((r) => r.pack_id));

  // Express middleware for /uploads/stickers: answers for built-in files only,
  // with the PNG to clients that cannot draw SVG. The response depends on the
  // Accept header, so shared caches must not keep it (private, Vary: Accept),
  // and a drawing update shows up within a day instead of the uploads
  // folder's week-long immutable cache.
  function serve(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let name;
    try { name = decodeURIComponent(req.path.replace(/^\/+/, '')); } catch { return next(); }
    const s = served.get(name);
    if (!s) return next();
    res.setHeader('Vary', 'Accept, Origin');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (wantsRaster(req)) {
      res.type('image/png');
      return res.sendFile(s.png, { cacheControl: false, lastModified: false });
    }
    // Same rules as any SVG under /uploads: fine in <img>, never runnable.
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.type('image/svg+xml');
    // root keeps the dotfile check to the file name: the data folder itself
    // often sits under a dot folder such as ~/.local/share.
    return res.sendFile(name, { root: stickersDir, cacheControl: false, lastModified: false, dotfiles: 'deny' });
  }

  return { packs, sync, syncAndLog, packStates, setPackEnabled, restorePack, noteDeleted, describe, disabledPacks, serve, refreshServed };
}

module.exports = { createBuiltinStickers, loadManifest, wantsRaster, STARTER_SHA256 };

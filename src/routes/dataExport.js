'use strict';

// Export my data (Settings, Data & privacy): GET /api/me/export.
//
// One JSON file with the member's account, their own settings, the channels
// they are in or wrote in, everything they wrote, and who they blocked.
// Nothing written by anyone else is included. Encrypted DMs go out as they
// are stored (still encrypted); the server never had the plaintext.
//
// Messages are read and written a page at a time, so a member with years of
// history does not have it all in memory at once, and the response waits for
// the connection to drain between pages.
//
// Signed in with the same Bearer token as every other /api route. Three
// exports an hour per member; guests have nothing to keep and get a 403.

const { verifyToken } = require('../auth');
const { utcStamp, looksEncrypted } = require('../socketHandlers/helpers');

const EXPORTS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
const PAGE = 500;

module.exports = function registerDataExport({ app }) {
  // userId -> timestamps of exports started in the last hour
  const exportStamps = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of exportStamps) {
      const f = t.filter(x => now - x < HOUR_MS);
      if (!f.length) exportStamps.delete(id); else exportStamps.set(id, f);
    }
  }, 10 * 60 * 1000).unref();

  app.get('/api/me/export', async (req, res) => {
    const auth = req.headers.authorization;
    const decoded = auth && auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
    const { getDb } = require('../database');
    const db = getDb();
    const user = db.prepare(`
      SELECT id, username, COALESCE(display_name, username) AS display_name, created_at, bio, avatar, is_guest, auto_delete_days
      FROM users WHERE id = ?
    `).get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (user.is_guest || decoded.isGuest) return res.status(403).json({ error: 'Guest accounts have no data to export' });

    const now = Date.now();
    const stamps = (exportStamps.get(user.id) || []).filter(t => now - t < HOUR_MS);
    if (stamps.length >= EXPORTS_PER_HOUR) {
      exportStamps.set(user.id, stamps);
      res.setHeader('Retry-After', String(Math.ceil((stamps[0] + HOUR_MS - now) / 1000)));
      return res.status(429).json({ error: `You can export your data ${EXPORTS_PER_HOUR} times an hour. Try again later.` });
    }
    stamps.push(now);
    exportStamps.set(user.id, stamps);

    let head;
    try {
      const serverName = db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get();
      const nicknames = {};
      for (const r of db.prepare('SELECT target_id, nickname FROM user_nicknames WHERE owner_id = ?').all(user.id)) nicknames[r.target_id] = r.nickname;
      // Channels they are in, and any they wrote in and have since left. A
      // channel they left is listed by a stand-in code: its real code may be
      // a private invite code they no longer hold.
      const rows = db.prepare(`
        SELECT c.id, c.code, c.name, c.is_dm, COALESCE(c.is_group, 0) AS is_group,
               EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = @uid) AS member
        FROM channels c
        WHERE c.id IN (SELECT channel_id FROM channel_members WHERE user_id = @uid)
           OR c.id IN (SELECT DISTINCT channel_id FROM messages WHERE user_id = @uid)
        ORDER BY c.id
      `).all({ uid: user.id });
      const partner = db.prepare(`
        SELECT COALESCE(u.display_name, u.username) AS name FROM channel_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = ? AND cm.user_id != ? LIMIT 1
      `);
      const codeOf = new Map();
      const channels = rows.map((c) => {
        const code = c.member ? c.code : `former-${c.id}`;
        codeOf.set(c.id, code);
        const type = c.is_group ? 'group' : (c.is_dm ? 'dm' : 'channel');
        // A 1:1 DM is stored as "DM"; the other person's name says which one.
        const name = type === 'dm' ? ((c.member && partner.get(c.id, user.id)) || { name: c.name }).name : c.name;
        return { code, name, type };
      });
      const blockedUsers = db.prepare(`
        SELECT u.id, u.username FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ? ORDER BY b.created_at, b.blocked_id
      `).all(user.id);
      const profile = { id: user.id, username: user.username, displayName: user.display_name, createdAt: utcStamp(user.created_at) };
      if (user.bio) profile.bio = user.bio;
      if (user.avatar) profile.avatar = user.avatar;
      head = {
        doc: {
          format: 'haven-export', version: 1, exportedAt: new Date(now).toISOString(),
          server: { name: serverName ? serverName.value : '' },
          user: profile,
          settings: { autoDeleteDays: user.auto_delete_days || 0, nicknames },
          channels,
        },
        codeOf, blockedUsers,
      };
    } catch (err) {
      console.error('Data export failed:', err.message);
      return res.status(500).json({ error: 'Could not build your export' });
    }

    const safeName = String(user.username).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'user';
    const day = new Date(now).toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="haven-export-${safeName}-${day}.json"`);
    res.setHeader('Cache-Control', 'no-store');

    let closed = false;
    res.on('close', () => { closed = true; });
    const write = (chunk) => new Promise((resolve) => {
      if (closed) return resolve();
      if (res.write(chunk)) return resolve();
      const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
      res.on('drain', done);
      res.on('close', done);
    });

    try {
      const opening = JSON.stringify(head.doc);
      await write(opening.slice(0, -1) + ',"messages":[');
      const page = db.prepare(`
        SELECT id, channel_id, created_at, edited_at, reply_to, content
        FROM messages WHERE user_id = ? AND id > ? ORDER BY id LIMIT ${PAGE}
      `);
      let after = 0;
      let first = true;
      for (;;) {
        if (closed) return;
        const batch = page.all(user.id, after);
        if (!batch.length) break;
        let out = '';
        for (const m of batch) {
          const item = { id: m.id, channel: head.codeOf.get(m.channel_id) || `former-${m.channel_id}`, createdAt: utcStamp(m.created_at) };
          if (m.edited_at) item.editedAt = utcStamp(m.edited_at);
          if (m.reply_to) item.replyTo = m.reply_to;
          item.content = m.content == null ? '' : m.content;
          item.encrypted = looksEncrypted(m.content);
          out += (first ? '' : ',') + JSON.stringify(item);
          first = false;
        }
        after = batch[batch.length - 1].id;
        await write(out);
        if (batch.length < PAGE) break;
      }
      await write('],"blockedUsers":' + JSON.stringify(head.blockedUsers) + '}');
      res.end();
    } catch (err) {
      console.error('Data export failed while streaming:', err.message);
      res.destroy(err);
    }
  });
};

'use strict';

// Settings, Data & privacy: Auto-delete my messages and Blocked users.
// Delete my messages is self-purge-messages in messages.js, and Export my
// data is GET /api/me/export (src/routes/dataExport.js).

const bcrypt = require('bcryptjs');
const { isInt } = require('./helpers');
const selfPurge = require('../selfPurge');
const userBlocks = require('../userBlocks');

module.exports = function register(socket, ctx) {
  const { io, db, logAudit } = ctx;
  // Each of these takes an ack; a payload is optional for the read-only ones.
  const args = (data, callback) => (typeof data === 'function'
    ? { data: {}, cb: data }
    : { data: data && typeof data === 'object' ? data : {}, cb: typeof callback === 'function' ? callback : () => {} });
  const toMine = (event, payload) => {
    for (const [, s] of io.of('/').sockets) if (s.user && s.user.id === socket.user.id) s.emit(event, payload);
  };
  const autoDeleteDays = () => {
    const row = db.prepare('SELECT auto_delete_days FROM users WHERE id = ?').get(socket.user.id);
    return row ? row.auto_delete_days || 0 : 0;
  };

  socket.on('get-data-controls', (data, callback) => {
    const { cb } = args(data, callback);
    try {
      cb({ allowSelfPurge: selfPurge.selfPurgeAllowed(db), autoDeleteDays: autoDeleteDays(), isGuest: !!socket.user.isGuest });
    } catch (err) {
      console.error('get-data-controls error:', err.message);
      cb({ error: 'Could not load your data settings' });
    }
  });

  // Auto-delete my messages. Turning it on needs the password, the same as
  // deleting your messages by hand, since it does the same thing on a timer.
  // Turning it off is always allowed, even after an admin switched self-purge
  // off or for a guest, so nobody is stuck with it.
  socket.on('set-auto-delete-messages', async (data, callback) => {
    const { data: d, cb } = args(data, callback);
    const days = d.days;
    if (!Number.isInteger(days) || !selfPurge.AUTO_DELETE_CHOICES.includes(days)) {
      return cb({ error: 'Pick Off, 1 day, 7 days, 30 days, 90 days or 1 year' });
    }
    const uid = socket.user.id;
    if (days > 0) {
      if (!selfPurge.selfPurgeAllowed(db)) return cb({ error: 'This server does not allow deleting your messages automatically' });
      if (socket.user.isGuest) return cb({ error: 'Guest accounts cannot do this' });
      const password = typeof d.password === 'string' ? d.password : '';
      if (!password) return cb({ error: 'Password is required' });
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid);
      if (!row) return cb({ error: 'User not found' });
      try {
        if (!(await bcrypt.compare(password, row.password_hash))) return cb({ error: 'Incorrect password' });
      } catch (err) {
        console.error('Auto-delete password verification error:', err);
        return cb({ error: 'Password verification failed' });
      }
    }
    try {
      db.prepare('UPDATE users SET auto_delete_days = ? WHERE id = ?').run(days, uid);
    } catch (err) {
      console.error('set-auto-delete-messages error:', err.message);
      return cb({ error: 'Could not save the setting' });
    }
    cb({ success: true, autoDeleteDays: days });
    toMine('data-controls-updated', { autoDeleteDays: days });
    if (days > 0 && typeof ctx.purgeOwnMessages === 'function') {
      selfPurge.runAutoDelete({ db, purge: ctx.purgeOwnMessages, logAudit, onlyUserId: uid })
        .catch(err => console.error('Auto-delete first run failed:', err.message));
    }
  });

  // ── Blocked users ───────────────────────────────────────
  const blockedPush = () => {
    const blockedIds = userBlocks.blockedIds(db, socket.user.id);
    toMine('blocked-users-updated', { blockedIds });
    return blockedIds;
  };

  socket.on('block-user', (data, callback) => {
    const { data: d, cb } = args(data, callback);
    const target = d.userId;
    if (!isInt(target)) return cb({ error: 'Invalid user' });
    if (target === socket.user.id) return cb({ error: 'You can\'t block yourself' });
    try {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(target)) return cb({ error: 'User not found' });
      const already = db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(socket.user.id, target);
      if (!already) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ?').get(socket.user.id).n;
        if (count >= userBlocks.MAX_BLOCKS) return cb({ error: `You can block up to ${userBlocks.MAX_BLOCKS} people` });
        db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(socket.user.id, target);
      }
      cb({ success: true, blockedIds: blockedPush() });
    } catch (err) {
      console.error('block-user error:', err.message);
      cb({ error: 'Could not block this person' });
    }
  });

  socket.on('unblock-user', (data, callback) => {
    const { data: d, cb } = args(data, callback);
    if (!isInt(d.userId)) return cb({ error: 'Invalid user' });
    try {
      db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(socket.user.id, d.userId);
      cb({ success: true, blockedIds: blockedPush() });
    } catch (err) {
      console.error('unblock-user error:', err.message);
      cb({ error: 'Could not unblock this person' });
    }
  });

  socket.on('get-blocked-users', (data, callback) => {
    const { cb } = args(data, callback);
    try {
      const users = db.prepare(`
        SELECT u.id, u.username, COALESCE(u.display_name, u.username) AS displayName, u.avatar
        FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ? ORDER BY b.created_at, b.blocked_id
      `).all(socket.user.id).map(u => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar || null }));
      cb({ users });
    } catch (err) {
      console.error('get-blocked-users error:', err.message);
      cb({ users: [], error: 'Could not load blocked users' });
    }
  });
};

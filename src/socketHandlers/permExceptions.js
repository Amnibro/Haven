'use strict';

// Exceptions for one person on the Permissions > Users tab. A box changed
// there saves only that one permission: an override is kept only while it
// says something the person's roles and level would not, so a permission
// they get from another role is never frozen into an exception. "Reset to
// roles" removes every server-wide exception for them.
//
// The older set-user-server-perms (roles.js) saved every box at once, which
// turned whatever the person had from other roles into exceptions; it stays
// for clients that still send it.

const { isInt, VALID_ROLE_PERMS } = require('./helpers');

const ADMIN_ONLY_PERMS = ['transfer_admin', 'manage_roles', 'manage_server', 'delete_channel', 'view_all_channels'];

module.exports = function register(socket, ctx) {
  const { db, userHasPermission, getUserGlobalPermissions, getUserEffectiveLevel, logAudit, permPanel } = ctx;
  const audit = typeof logAudit === 'function' ? logAudit : () => {};

  // Who may edit whom, the same rules as the rest of the panel. Returns an
  // error string, or null when allowed.
  const refuse = (userId) => {
    if (!permPanel || !permPanel.canManagePermPanel(socket)) return 'Only admins can manage permissions';
    if (userId === socket.user.id) return 'You cannot change your own permissions here';
    const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId);
    if (!target) return 'User not found';
    if (target.is_admin) return 'The host already has every permission';
    if (!socket.user.isAdmin) {
      const myLevel = getUserEffectiveLevel(socket.user.id);
      if (getUserEffectiveLevel(userId) >= myLevel) return `You can only edit people below your level (${myLevel})`;
    }
    return null;
  };

  const canTouch = (perm) => {
    if (socket.user.isAdmin) return true;
    if (ADMIN_ONLY_PERMS.includes(perm)) return false;
    const mine = new Set(getUserGlobalPermissions(socket.user.id));
    return mine.has('*') || mine.has(perm);
  };

  const nameOf = (userId) => db.prepare('SELECT COALESCE(display_name, username) AS u FROM users WHERE id = ?').get(userId)?.u || null;

  socket.on('set-user-server-perm', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user || !data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const userId = isInt(data.userId) ? data.userId : null;
    const perm = typeof data.permission === 'string' ? data.permission : '';
    if (!userId || !VALID_ROLE_PERMS.includes(perm) || typeof data.allowed !== 'boolean') return cb({ error: 'Invalid request' });
    const why = refuse(userId);
    if (why) return cb({ error: why });
    if (!canTouch(perm)) return cb({ error: 'You can only hand out permissions you have yourself' });

    let role = permPanel.primaryServerRole(userId);
    if (!role) {
      const auto = db.prepare("SELECT * FROM roles WHERE auto_assign = 1 AND scope = 'server' LIMIT 1").get();
      if (!auto) return cb({ error: 'This user has no role to attach permissions to' });
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, NULL, ?)')
        .run(userId, auto.id, socket.user.id);
      role = auto;
    }

    try {
      const apply = db.transaction(() => {
        // Clear any server-wide exception for this permission, see what the
        // roles and level give without one, and keep an exception only if
        // the wanted answer is different.
        db.prepare('DELETE FROM user_role_perms WHERE user_id = ? AND permission = ? AND channel_id IS NULL').run(userId, perm);
        const fromRoles = userHasPermission(userId, perm);
        if (fromRoles !== data.allowed) {
          db.prepare('INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed) VALUES (?, ?, NULL, ?, ?)')
            .run(userId, role.id, perm, data.allowed ? 1 : 0);
        }
        return fromRoles !== data.allowed;
      });
      const isException = apply();
      permPanel.refreshUserRoles(userId);
      cb({ success: true, permissions: getUserGlobalPermissions(userId), exception: isException });
      audit({ actor: socket.user, action: 'user_perms_update', target_type: 'user', target_id: userId,
        target_name: nameOf(userId), details: { permission: perm, allowed: data.allowed, exception: isException } });
    } catch (err) {
      console.error('set-user-server-perm error:', err);
      cb({ error: 'Failed to update permissions' });
    }
  });

  socket.on('reset-user-server-perms', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user || !data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const userId = isInt(data.userId) ? data.userId : null;
    if (!userId) return cb({ error: 'Invalid request' });
    const why = refuse(userId);
    if (why) return cb({ error: why });
    try {
      // Someone below the host only clears exceptions they could have set.
      const rows = db.prepare('SELECT id, permission FROM user_role_perms WHERE user_id = ? AND channel_id IS NULL').all(userId);
      const del = db.prepare('DELETE FROM user_role_perms WHERE id = ?');
      let cleared = 0;
      db.transaction(() => {
        for (const r of rows) {
          if (!canTouch(r.permission)) continue;
          del.run(r.id);
          cleared++;
        }
      })();
      permPanel.refreshUserRoles(userId);
      cb({ success: true, cleared, permissions: getUserGlobalPermissions(userId) });
      audit({ actor: socket.user, action: 'user_perms_reset', target_type: 'user', target_id: userId,
        target_name: nameOf(userId), details: { cleared } });
    } catch (err) {
      console.error('reset-user-server-perms error:', err);
      cb({ error: 'Failed to reset permissions' });
    }
  });
};

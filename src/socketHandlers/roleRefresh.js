'use strict';

// Pushing changed roles and permissions to the people who hold them, live,
// so nobody has to reconnect to see what they may now do. Made once by
// setupSocketHandlers and shared by the role handlers (roles.js) and server
// template imports.

module.exports = function createRoleRefresh(ctx) {
  const {
    io, db, state, userHasPermission, getUserEffectiveLevel,
    getUserPermissions, getUserGlobalPermissions, getUserRoles,
    emitOnlineUsers, getEnrichedChannels
  } = ctx;

  // ── Helper: live-refresh for 'view_all_channels' ────────
  // A role that grants view_all_channels changes what its holder can SEE, so
  // push them a rebuilt channel list (joining the new rooms) the same way
  // applyRoleChannelAccess does, instead of it only appearing on next login.
  function roleGrantsSeeAll(roleId) {
    return !!db.prepare(
      "SELECT 1 FROM role_permissions WHERE role_id = ? AND permission = 'view_all_channels' AND allowed = 1"
    ).get(roleId);
  }
  function pushChannelList(userId) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.emit('channels-list', getEnrichedChannels(userId, s.user.isAdmin, (room) => s.join(room)));
      }
    }
  }

  // ── Helper: undo view_all_channels auto-joins ───────────
  // Granting the permission writes a real membership row for every channel, so
  // losing it has to take those rows back. Without this, demoting a mod leaves
  // them sitting in every private channel on the server, which is the opposite
  // of what demoting someone means. No-ops when they still hold the permission
  // through some other role, and never touches memberships they got another
  // way. (#5512)
  function syncSeeAllMemberships(userId) {
    const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
    if (row && row.is_admin) return;
    if (userHasPermission(userId, 'view_all_channels')) return;

    const losing = db.prepare(`
      SELECT c.code FROM channel_members cm
      JOIN channels c ON c.id = cm.channel_id
      WHERE cm.user_id = ? AND cm.auto_all_channels = 1
    `).all(userId);
    if (!losing.length) return;

    db.prepare('DELETE FROM channel_members WHERE user_id = ? AND auto_all_channels = 1').run(userId);

    // Leaving the rooms matters as much as the rows do: a socket still in
    // channel:<code> keeps receiving live messages from a channel the user can
    // no longer open.
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        losing.forEach(ch => s.leave(`channel:${ch.code}`));
        s.emit('channels-list', getEnrichedChannels(userId, s.user.isAdmin, (room) => s.join(room)));
      }
    }
  }

  // ── Notify helper: push one user's recomputed role state to their sockets ──
  // Recomputes from the DB, so it's correct whether the change was to the
  // user's role ASSIGNMENTS (assign/revoke/promote) or to the PERMISSIONS of a
  // role they already hold (update-role / reset-roles-to-default).
  function pushUserRoleState(userId) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === userId) {
        s.user.roles = getUserRoles(userId);
        s.user.effectiveLevel = getUserEffectiveLevel(userId);
        s.emit('roles-updated', {
          roles: s.user.roles,
          effectiveLevel: s.user.effectiveLevel,
          permissions: getUserPermissions(userId),
          globalPermissions: getUserGlobalPermissions(userId)
        });
      }
    }
  }

  // A role's permissions or level changed. Everyone online gets fresh member
  // lists (badges and ordering), and each holder of the roles gets their own
  // recomputed permission set: the payload-less roles-updated broadcast only
  // nudges open Role Management screens, so without this a moderator granted
  // e.g. ban_ip kept their old permissions until they reconnected. Used by
  // update-role and by server template imports.
  function refreshRoleHolders(roleIds) {
    for (const [code] of state.channelUsers) { emitOnlineUsers(code); }
    for (const roleId of roleIds) {
      const affected = db.prepare('SELECT DISTINCT user_id FROM user_roles WHERE role_id = ?').all(roleId);
      for (const row of affected) pushUserRoleState(row.user_id);
      // Granting view_all_channels grows every holder's visible channel set,
      // so their lists are refreshed live, as assign-role does; losing it
      // takes back the memberships it added.
      if (roleGrantsSeeAll(roleId)) for (const row of affected) pushChannelList(row.user_id);
      else for (const row of affected) syncSeeAllMemberships(row.user_id);
    }
  }

  return { roleGrantsSeeAll, pushChannelList, syncSeeAllMemberships, pushUserRoleState, refreshRoleHolders };
};

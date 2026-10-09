'use strict';

// Defaults for new members (#5739): the admin's controls, and the one-time
// hand-over of the account-level defaults to each member.

const memberDefaults = require('../memberDefaults');
const { createSettingEffects } = require('./settingEffects');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, automod, emitOnlineUsers, onReferrerPolicyChange, logAudit } = ctx;
  const { emitSettingChanged, auditSettingChange } = ctx.settingEffects
    || createSettingEffects({ io, automod, channelUsers: ctx.state?.channelUsers || new Map(), emitOnlineUsers, onReferrerPolicyChange, logAudit });

  // Same gate as the rest of the server settings. Any error denies.
  const canManage = () => {
    try {
      return !!(socket.user && (socket.user.isAdmin || userHasPermission(socket.user.id, 'manage_server')));
    } catch (err) {
      console.warn('[member-defaults] permission check failed:', err.message);
      return false;
    }
  };

  const saved = (value, message) => {
    emitSettingChanged(memberDefaults.SETTING_KEY, value);
    auditSettingChange(socket.user, memberDefaults.SETTING_KEY, value);
    socket.emit('toast', { message, type: 'success' });
  };

  socket.on('set-member-defaults', (data) => {
    if (!canManage()) return socket.emit('error-msg', 'Only admins can change server settings');
    if (!data || typeof data !== 'object') return;
    const value = memberDefaults.saveDefaults(db, data.settings);
    if (!value) return socket.emit('error-msg', 'Pick at least one setting to share');
    saved(value, 'Defaults for new members saved');
  });

  socket.on('clear-member-defaults', () => {
    if (!canManage()) return socket.emit('error-msg', 'Only admins can change server settings');
    saved(memberDefaults.clearDefaults(db), 'Defaults for new members cleared');
  });

  socket.on('push-member-defaults', () => {
    if (!canManage()) return socket.emit('error-msg', 'Only admins can change server settings');
    const value = memberDefaults.bumpDefaults(db);
    if (!value) return socket.emit('error-msg', 'Save some defaults first');
    saved(value, 'Everyone gets these defaults once at their next load');
  });

  // Asked by the member's own client at load. Only ever touches the asking
  // member's own preferences.
  socket.on('apply-member-defaults', () => {
    if (!socket.user || !socket.user.id) return;
    let applied = {};
    try {
      applied = memberDefaults.applyAccountDefaults(db, socket.user.id);
    } catch (err) {
      console.warn('[member-defaults] could not apply:', err.message);
    }
    socket.emit('member-defaults-applied', applied);
  });
};

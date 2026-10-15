'use strict';

// Why an IP ban may not cover `entry` (an address or CIDR range), or null.
// A ban on this machine, on whoever places it, or on staff locks out the
// people who would have to lift it. Shared by the manual ban, the linked-IP
// ban, the bulk cleanup and automod, so every path refuses the same things.
//
// opts:
//   getUserEffectiveLevel  (userId) => number
//   actorId, actorIp       the person placing the ban (null for automod)
//   protectAdmins          refuse addresses an admin has used
//   protectLevel           refuse addresses used by anyone at or above it
const { ipMatches } = require('./clientIp');

function ipBanRefusal(db, entry, opts = {}) {
  const { getUserEffectiveLevel, actorId = null, actorIp = null, protectAdmins = true, protectLevel = Infinity } = opts;
  if (ipMatches('127.0.0.1', entry) || ipMatches('::1', entry)) return 'That would ban the server\'s own machine.';
  if (actorIp && ipMatches(actorIp, entry)) return 'That would ban your own address.';
  const seen = db.prepare('SELECT ui.user_id, ui.ip, u.is_admin FROM user_ips ui JOIN users u ON u.id = ui.user_id').all();
  for (const r of seen) {
    if (!ipMatches(r.ip, entry)) continue;
    if (actorId !== null && r.user_id === actorId) return 'That would ban an address you use.';
    if (r.is_admin) {
      if (protectAdmins) return 'That address is used by the admin.';
      continue;
    }
    if (Number.isFinite(protectLevel) && typeof getUserEffectiveLevel === 'function' && getUserEffectiveLevel(r.user_id) >= protectLevel) {
      return 'That address is used by someone of equal or higher rank.';
    }
  }
  return null;
}

module.exports = { ipBanRefusal };

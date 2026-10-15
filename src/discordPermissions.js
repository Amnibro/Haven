'use strict';

/**
 * Which Discord channels a bot can actually read.
 *
 * Discord lists every channel of a server to a bot, private ones included, but
 * a private channel (its overwrites deny View Channel to @everyone and do not
 * let the bot's role back in) stays closed to it even when the bot's
 * server-wide role can view and read everything. The import picker and the
 * Ferry pairing form use this to say so up front instead of failing quietly.
 *
 * This follows Discord's documented calculation: @everyone plus the member's
 * roles give the base, Administrator (or owning the server) allows everything,
 * then the channel's overwrites apply in order: @everyone, the member's roles
 * together, then the member. Category children carry their own overwrites in
 * the API, so each channel is worked out on its own.
 *
 * Pure: no network, no state. Permissions arrive from Discord as decimal
 * strings and are handled as BigInt.
 */

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ALL = (1n << 64n) - 1n;

/** A permission value from Discord (decimal string or number) as BigInt, 0 when absent or malformed. */
function bits(value) {
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

// Overwrite types: 0 or "role" is a role, 1 or "member" is one member.
function isRoleOverwrite(o) { return o.type === 0 || o.type === '0' || o.type === 'role'; }
function isMemberOverwrite(o) { return o.type === 1 || o.type === '1' || o.type === 'member'; }

/**
 * What the calculation needs, from a guild object (GET /guilds/{id}, or a
 * gateway GUILD_CREATE) and the bot's member object in it. Null when either
 * is missing, which callers treat as "unknown" and show no warning.
 */
function accessContext({ guild, member, userId }) {
  if (!guild || !guild.id || !Array.isArray(guild.roles)) return null;
  if (!member || !Array.isArray(member.roles) || !userId) return null;
  const roles = new Map();
  for (const r of guild.roles) if (r && r.id) roles.set(String(r.id), bits(r.permissions));
  // Without @everyone the base permissions cannot be known.
  if (!roles.has(String(guild.id))) return null;
  return {
    guildId: String(guild.id),
    ownerId: guild.owner_id ? String(guild.owner_id) : null,
    userId: String(userId),
    roles,
    memberRoleIds: member.roles.map(String),
  };
}

/** Server-wide permissions, before any channel overwrite. */
function basePermissions(ctx) {
  if (ctx.ownerId && ctx.ownerId === ctx.userId) return ALL;
  let perms = ctx.roles.get(ctx.guildId) || 0n;
  for (const id of ctx.memberRoleIds) perms |= ctx.roles.get(id) || 0n;
  return (perms & ADMINISTRATOR) ? ALL : perms;
}

/** Permissions in one channel, given that channel's permission_overwrites. */
function channelPermissions(ctx, overwrites) {
  const base = basePermissions(ctx);
  if (base & ADMINISTRATOR) return ALL;
  const list = (Array.isArray(overwrites) ? overwrites : []).filter(o => o && o.id);
  let perms = base;

  const everyone = list.find(o => String(o.id) === ctx.guildId);
  if (everyone) {
    perms &= ~bits(everyone.deny);
    perms |= bits(everyone.allow);
  }

  // Every role the member holds counts at once: denies first, then allows,
  // so one role's allow beats another role's deny.
  const mine = new Set(ctx.memberRoleIds);
  let allow = 0n, deny = 0n;
  for (const o of list) {
    const id = String(o.id);
    if (id === ctx.guildId || !isRoleOverwrite(o) || !mine.has(id)) continue;
    allow |= bits(o.allow);
    deny |= bits(o.deny);
  }
  perms &= ~deny;
  perms |= allow;

  const own = list.find(o => isMemberOverwrite(o) && String(o.id) === ctx.userId);
  if (own) {
    perms &= ~bits(own.deny);
    perms |= bits(own.allow);
  }
  return perms;
}

/**
 * { view, readHistory } for one channel object (anything with
 * permission_overwrites). Without View Channel nothing else applies.
 */
function channelAccess(ctx, channel) {
  const perms = channelPermissions(ctx, channel && channel.permission_overwrites);
  const view = (perms & VIEW_CHANNEL) !== 0n;
  return { view, readHistory: view && (perms & READ_MESSAGE_HISTORY) !== 0n };
}

/** True when the bot can open the channel and read its past messages. */
function canReadHistory(ctx, channel) {
  const a = channelAccess(ctx, channel);
  return a.view && a.readHistory;
}

module.exports = {
  ADMINISTRATOR,
  VIEW_CHANNEL,
  READ_MESSAGE_HISTORY,
  bits,
  accessContext,
  basePermissions,
  channelPermissions,
  channelAccess,
  canReadHistory,
};

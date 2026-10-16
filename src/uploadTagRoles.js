'use strict';

// Upload tags limited to a role (#5751). In Settings > Tags an admin can tie
// a tag to a role, say an NSFW tag to the NSFW role people pick when they
// join. Then only members who hold that role are offered the tag in the
// tagging pickers and can put it on, or take it off, an upload; the server
// enforces it, so an old or patched client gets nowhere. Admins always can.
//
// What the role limits is tagging, not reading. A tag that is already on a
// picture stays visible to everyone who can see the picture (its footer, the
// gallery, search by tag): it describes something they can already see, and
// hiding an "NSFW" label from people without the role would hide the very
// warning they might want. The pickers do leave restricted tags out for
// members without the role, so nobody is offered a tag they cannot use.
//
// Fails closed: a tag whose role was deleted is held by nobody, so only
// admins can apply it until one picks another role or clears the limit.

// The role ids a member holds, server-wide or on one of `channelIds` (the
// channel and the ones above it, so a role given on a category counts in its
// channels).
function heldRoleIds(db, userId, channelIds = []) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).filter(Number.isInteger);
  const scope = ids.length ? ` OR channel_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT role_id FROM user_roles WHERE user_id = ? AND (channel_id IS NULL${scope})`)
    .all(userId, ...ids);
  return new Set(rows.map(r => r.role_id));
}

// Which tags someone may use: every one for an admin, otherwise the
// unrestricted ones and those tied to a role they hold.
function tagAccess(db, { userId, isAdmin = false, channelIds = [] } = {}) {
  if (isAdmin) return { all: true, held: new Set() };
  return { all: false, held: heldRoleIds(db, userId, channelIds) };
}

// Whether `access` lets someone use `tag` (a row carrying role_id). No access
// given means no restricted tags, so a caller that forgets fails closed.
function canUseTag(access, tag) {
  if (!tag) return false;
  if (tag.role_id == null) return true;
  if (!access) return false;
  return !!access.all || access.held.has(tag.role_id);
}

// A WHERE fragment keeping only the tags `access` may use, for a query over
// upload_tags under `alias`.
function usableTagSql(access, alias = 'upload_tags') {
  if (access && access.all) return { sql: '', params: [] };
  const held = access ? [...access.held] : [];
  if (!held.length) return { sql: ` AND ${alias}.role_id IS NULL`, params: [] };
  return { sql: ` AND (${alias}.role_id IS NULL OR ${alias}.role_id IN (${held.map(() => '?').join(',')}))`, params: held };
}

// Admin: tie a tag to a role, or lift the limit with roleId null. Returns
// { ok, tag } or { error } ('bad_request', 'not_found', 'no_role').
function setTagRole(db, { tagId, roleId }) {
  if (!Number.isInteger(tagId)) return { error: 'bad_request' };
  if (roleId !== null && !Number.isInteger(roleId)) return { error: 'bad_request' };
  const tag = db.prepare('SELECT id, name FROM upload_tags WHERE id = ?').get(tagId);
  if (!tag) return { error: 'not_found' };
  if (roleId !== null && !db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId)) return { error: 'no_role' };
  db.prepare('UPDATE upload_tags SET role_id = ? WHERE id = ?').run(roleId, tagId);
  return { ok: true, tag: { id: tag.id, name: tag.name, roleId } };
}

module.exports = { heldRoleIds, tagAccess, canUseTag, usableTagSql, setTagRole };

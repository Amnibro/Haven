'use strict';

/**
 * Haven used to hand some permissions to every role at or above a level,
 * whatever the role's boxes said (server_settings.permission_thresholds; by
 * default Create Channels and Manage Channel Settings at level 50). Nothing
 * on screen showed it, and unticking such a box changed nothing. The rule is
 * gone (owner, 2026-10-16): a role has what is ticked.
 *
 * This turns the old rule into ticks once, at start-up, so nobody loses a
 * permission they had, then empties the setting:
 *   - every server role at or above a level gets the permission ticked; a
 *     stored "denied" for it goes, as the old rule overrode that anyway,
 *   - someone ranked above their role on one assignment (custom_level) who
 *     held it only through that rank keeps it as an exception of their own,
 *     unless an exception for it already says otherwise,
 *   - someone the new tick would reach who did not have it before (ranked
 *     below such a role on their own assignment, or holding it only inside a
 *     channel, which the rule never counted) gets an exception saying no, so
 *     nobody gains it either. Anyone it reached through a tick of its own, or
 *     with an exception for it already, is left alone.
 * With the setting empty it does nothing on later starts.
 *
 * New roles made at level 50 or above start with the two ticked instead
 * (app-role-tools.js), and can be unticked like any other permission.
 */

function readThresholds(db) {
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn('[perms] permission_thresholds is not valid JSON, clearing it:', err.message);
    return {};
  }
}

function convertPermissionThresholds(db) {
  const thresholds = readThresholds(db);
  if (thresholds === null) return { converted: 0 };
  const entries = Object.entries(thresholds)
    .filter(([perm, min]) => typeof perm === 'string' && perm && Number.isInteger(min) && min >= 1 && min <= 100);
  if (!entries.length && JSON.stringify(thresholds) === '{}') return { converted: 0 };

  const serverRoles = "SELECT id FROM roles WHERE COALESCE(scope, 'server') = 'server' AND level >= ?";
  const dropDenied = db.prepare(`DELETE FROM role_permissions WHERE permission = ? AND allowed = 0 AND role_id IN (${serverRoles})`);
  const tick = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) SELECT id, ?, 1 FROM roles
    WHERE COALESCE(scope, 'server') = 'server' AND level >= ?`);
  const keepByRank = db.prepare(`
    INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed)
    SELECT ur.user_id, MIN(ur.role_id), NULL, ?, 1
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.channel_id IS NULL AND COALESCE(r.scope, 'server') = 'server'
      AND ur.custom_level >= ? AND r.level < ?
      AND NOT EXISTS (SELECT 1 FROM user_role_perms x WHERE x.user_id = ur.user_id AND x.permission = ? AND x.channel_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM user_roles u2 JOIN roles r2 ON r2.id = u2.role_id
                      WHERE u2.user_id = ur.user_id AND u2.channel_id IS NULL
                        AND COALESCE(r2.scope, 'server') = 'server' AND r2.level >= ?)
    GROUP BY ur.user_id`);

  // Worked out before the ticks go in: who holds a role the tick will reach
  // but did not have the permission under the old rule (effective rank from
  // server-wide assignments below the level) or any other way.
  const keepOut = db.prepare(`
    INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed)
    SELECT ur.user_id, MIN(ur.role_id), NULL, ?, 0
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE COALESCE(r.scope, 'server') = 'server' AND r.level >= ?
      AND NOT EXISTS (SELECT 1 FROM user_role_perms x WHERE x.user_id = ur.user_id AND x.permission = ?)
      AND COALESCE((SELECT MAX(COALESCE(u2.custom_level, r2.level)) FROM user_roles u2 JOIN roles r2 ON r2.id = u2.role_id
                    WHERE u2.user_id = ur.user_id AND u2.channel_id IS NULL AND COALESCE(r2.scope, 'server') = 'server'), 0) < ?
      AND NOT EXISTS (SELECT 1 FROM user_roles u3 JOIN role_permissions rp ON rp.role_id = u3.role_id
                      WHERE u3.user_id = ur.user_id AND rp.permission = ? AND rp.allowed = 1)
    GROUP BY ur.user_id`);

  let converted = 0;
  db.transaction(() => {
    for (const [perm, min] of entries) {
      converted += keepOut.run(perm, min, perm, min, perm).changes;
      dropDenied.run(perm, min);
      converted += tick.run(perm, min).changes;
      converted += keepByRank.run(perm, min, min, perm, min).changes;
    }
    db.prepare("UPDATE server_settings SET value = '{}' WHERE key = 'permission_thresholds'").run();
  })();
  return { converted };
}

module.exports = { convertPermissionThresholds };

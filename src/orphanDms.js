'use strict';

// DM channels the auto-cleanup sweep removes (#5282): a 1:1 DM that has
// dropped below two members because someone deleted their account or was
// removed. A group DM is orphaned only once nobody is left: one member
// waiting on invites, or the last one still in it, is not an orphan. A DM
// with yourself (notes to self) has one member by design and never is.
function findOrphanDms(db) {
  return db.prepare(`
    SELECT c.id, c.code, COUNT(cm.user_id) as member_count
    FROM channels c
    LEFT JOIN channel_members cm ON cm.channel_id = c.id
    WHERE c.is_dm = 1 AND COALESCE(c.is_self_dm, 0) = 0
    GROUP BY c.id
    HAVING member_count < (CASE WHEN COALESCE(c.is_group, 0) = 1 THEN 1 ELSE 2 END)
  `).all();
}

module.exports = { findOrphanDms };

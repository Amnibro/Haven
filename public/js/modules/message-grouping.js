// When a message folds under the one before it (no avatar or name of its
// own). One rule for channels, DMs, group DMs, the pop-out DM and threads.
//
// Pure, with no DOM, so it can be tested on its own.

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

const localDay = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
};

// prev and msg are message objects (or what groupInfoFromElement rebuilt
// from the element on screen). A different author or persona, a system line,
// /break, a webhook or imported message next to a normal one, a reply, more
// than five minutes, or a new day each start a new group.
export function groupsWithPrevious(prev, msg) {
  if (!prev || !msg) return false;
  if ((prev.type || 'user') !== 'user' || (msg.type || 'user') !== 'user') return false;
  if (prev.user_id == null || prev.user_id !== msg.user_id) return false;
  // Persona, webhook and Discord-imported messages each break the chain, so
  // a different persona under the same account never folds under the last
  // one's avatar (#5349, #5393).
  if ((prev.persona_id || null) !== (msg.persona_id || null)) return false;
  if ((prev.persona_username || null) !== (msg.persona_username || null)) return false;
  if ((prev.username || null) !== (msg.username || null)) return false;
  if ((prev.is_webhook ? 1 : 0) !== (msg.is_webhook ? 1 : 0)) return false;
  if ((prev.webhook_username || null) !== (msg.webhook_username || null)) return false;
  if ((prev.imported_from || null) !== (msg.imported_from || null)) return false;
  // /break and the saved break_chain flag (#5393).
  if (msg.break_chain || prev.break_chain) return false;
  if (msg.reply_to) return false;
  const a = new Date(prev.created_at).getTime();
  const b = new Date(msg.created_at).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Math.abs(b - a) >= GROUP_WINDOW_MS) return false;
  return localDay(a) === localDay(b);
}

// What the grouping rule needs from a message element already on screen
// (channel, DM, pop-out DM or thread rows all keep it in data attributes).
// Null when the element is not a message, such as a divider or system line.
export function groupInfoFromElement(el) {
  const d = el && el.dataset;
  if (!d || !d.userId || !d.msgId) return null;
  return {
    user_id: parseInt(d.userId, 10),
    username: d.username || null,
    persona_id: d.personaId ? parseInt(d.personaId, 10) : null,
    persona_username: d.personaUsername || null,
    break_chain: d.breakChain === '1' ? 1 : 0,
    highlight: d.highlighted === '1' || undefined,
    is_webhook: d.webhook === '1' ? 1 : 0,
    webhook_username: d.webhookUsername || null,
    imported_from: d.importedFrom || null,
    created_at: d.time,
  };
}

// Keeps where a message came from on its element, so the next message can
// be compared with it once only the element is left (a live message, the
// pop-out DM, every thread reply).
export function stampGroupSource(el, msg) {
  if (!el || !msg) return;
  if (msg.is_webhook) el.dataset.webhook = '1';
  if (msg.webhook_username) el.dataset.webhookUsername = msg.webhook_username;
  if (msg.imported_from) el.dataset.importedFrom = msg.imported_from;
}

// The same three, as app methods for the message, thread and pop-out DM code.
export default {
  _groupsWithPrevious: groupsWithPrevious,
  _groupInfoFromElement: groupInfoFromElement,
  _stampGroupSource: stampGroupSource,
};

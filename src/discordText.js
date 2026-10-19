'use strict';

// Text that arrives from Discord, through Ferry or an import, in the shape
// Haven shows it.

// Discord hides a backslash typed in front of punctuation, so "3\.1K" reads
// "3.1K" there; bots that write embeds (fxtwitter and friends) escape their
// text that way. Haven shows backslashes as typed, which is what /shrug relies
// on, so the escapes are undone here instead, for characters that mean
// nothing in Haven's formatting. The rest stay escaped: undoing "\*" or "\@"
// would turn plain text into italics or a ping. A "\." right after a number
// at the start of a line stays too, since "1." there starts a list.
function unescapeDiscord(text) {
  return String(text || '').replace(/\\([\\.!(){},;'"?%&$/])/g, (full, ch, offset, all) => {
    if (ch === '.' && /(^|\n)[ \t]*\d+$/.test(all.slice(0, offset))) return full;
    return ch;
  });
}

// A forwarded message carries its content in message_snapshots and has none
// of its own, so it used to arrive empty or not at all. Returns the
// forwarded message (content, attachments, embeds, components) or null.
function forwardedMessage(msg) {
  const snap = Array.isArray(msg && msg.message_snapshots) ? msg.message_snapshots[0] : null;
  const inner = snap && snap.message;
  return inner && typeof inner === 'object' ? inner : null;
}

// Puts "Forwarded" over the forwarded text as a quote, the way Discord marks it.
function quoteForwarded(text) {
  const lines = String(text || '').split('\n').filter((l, i, all) => l || all.length > 1);
  return ['> *Forwarded*', ...lines.map(l => (l ? `> ${l}` : '>'))].join('\n');
}

module.exports = { unescapeDiscord, forwardedMessage, quoteForwarded };

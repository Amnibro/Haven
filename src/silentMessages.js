'use strict';

// Silent messages: posted like any other, but nobody gets a sound, a pop-up
// or a push for them. Mentions in one still show (the highlight and the
// mention marker); they just do not ping. Unread counts still go up.
//
// A message is silent when the sender starts it with "@silent" (the prefix
// Discord uses, taken off before the message is stored) or when the client
// says so with `silent: true` (the composer's toggle, and encrypted DMs, whose
// text the server cannot read). Stored as messages.silent so history shows
// the muted bell too.

const SILENT_PREFIX = /^\s*@silent(?:[ \t]+|\r?\n)/i;

// { silent, content }: whether the message is silent, and its text with the
// prefix taken off. "@silent" with nothing after it is left as plain text, so
// a message never ends up empty.
function takeSilent(content, flag) {
  const text = typeof content === 'string' ? content : '';
  const m = SILENT_PREFIX.exec(text);
  if (m) {
    const rest = text.slice(m[0].length);
    if (rest.trim()) return { silent: true, content: rest };
  }
  return { silent: flag === true, content: text };
}

module.exports = { takeSilent, SILENT_PREFIX };

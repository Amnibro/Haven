'use strict';

// Shared clean-up for the fields a bot shows to everyone: its name and its
// avatar. They come from the Bot Manager and, per message, from whoever holds
// the bot token, so neither is trusted.

const MAX_NAME = 32;
const MAX_AVATAR_URL = 512;

// C0/C1 controls plus the bidi and direction marks that can flip how the
// surrounding text reads. '<' and '>' go too: a name is never markup.
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩<>]/g;

function cleanWebhookName(raw) {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(NAME_STRIP_RE, '').trim();
  // Count code points, so an emoji is never cut in half.
  return Array.from(stripped).slice(0, MAX_NAME).join('').trim();
}

// An avatar is either one of this server's uploads or an https image that
// clients load through the media proxy. Anything else (http, data:,
// javascript:, protocol-relative, credentials in the URL) is refused.
// Returns the cleaned URL, or null when there is none or it is not allowed.
function cleanWebhookAvatarUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_AVATAR_URL) return null;
  if (value.startsWith('/uploads/')) {
    const rest = value.slice('/uploads/'.length);
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rest)) return null;
    if (rest.split('/').some(part => part === '.' || part === '..')) return null;
    return value;
  }
  let url;
  try { url = new URL(value); } catch { return null; } // not a URL at all, so not an allowed avatar
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href.length > MAX_AVATAR_URL ? null : url.href;
}

module.exports = { cleanWebhookName, cleanWebhookAvatarUrl, MAX_NAME, MAX_AVATAR_URL };

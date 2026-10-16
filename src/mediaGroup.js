'use strict';

// Pictures and files sent together arrive as one message (#5799): the typed
// text on top, then one line per upload, the form forum topics already use
// (#5653, #5690). A picture is its bare /uploads path, optionally marked
// spoiler-img:, and any other file is "[file:Name](/uploads/<name>|size)".
//
// This reads those lines so a grouped message is held to the same limits as
// one attachment per message: how many files it carries, how long the typed
// part may be, and the channel's text and media switches. Encrypted DMs reach
// the server as ciphertext, so none of this applies to them; their sender
// names the files instead (send-message `files`).

const MAX_GROUP_MEDIA = 10;      // files one message carries at most
const FORUM_TOPIC_MEDIA = 50;    // a forum topic written in New Post, the setting's ceiling
const MEDIA_LINE_ROOM = 400;     // what one upload line may add past the typed limit
// How a message's pictures show: the grid, or full size one under another.
// The server setting media_group_layout holds the default, and a member's
// preference of the same name overrides it for them.
const MEDIA_GROUP_LAYOUTS = ['grid', 'stacked'];

const PICTURE_LINE = /^(?:spoiler-img:)?\/uploads\/(?:[\w-]+\/)?[\w.-]+$/i;
const FILE_LINE = /^\[file:[^\]\n]+\]\(\/uploads\/[^\s|)]+\|[^)\n]+\)$/;

function isMediaLine(line) {
  const l = String(line || '').trim();
  return PICTURE_LINE.test(l) || FILE_LINE.test(l);
}

function lines(content) {
  return String(content || '').split('\n');
}

// The upload lines of a message, trimmed, in order.
function mediaLines(content) {
  return lines(content).map(l => l.trim()).filter(isMediaLine);
}

function mediaCount(content) {
  return mediaLines(content).length;
}

// What the sender typed: every line that is not an upload.
function typedText(content) {
  return lines(content).filter(l => !isMediaLine(l)).join('\n').trim();
}

// Nothing but uploads (at least one).
function isMediaOnly(content) {
  const filled = lines(content).map(l => l.trim()).filter(Boolean);
  return filled.length > 0 && filled.every(isMediaLine);
}

function hasMedia(content) {
  return mediaCount(content) > 0;
}

// How many files one message may carry. The admin's Uploads & Limits setting
// (max_attachments, 1 to 50) caps the composer's queue; a message takes at
// most ten of them and the composer sends the rest as further messages. A
// forum topic is written in New Post, which has never had a count, so it
// keeps the setting's ceiling.
function groupLimit({ maxAttachments, forumTopic = false } = {}) {
  if (forumTopic) return FORUM_TOPIC_MEDIA;
  const n = parseInt(maxAttachments, 10);
  const setting = Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : MAX_GROUP_MEDIA;
  return Math.min(MAX_GROUP_MEDIA, setting);
}

// The length limit is on what people type. Each upload line may add up to
// MEDIA_LINE_ROOM characters on top (a file line carries its name and size),
// so text at the limit plus its pictures is not refused.
function tooLong(content, maxChars) {
  const s = String(content || '');
  const count = mediaCount(s);
  if (!count) return s.length > maxChars;
  return typedText(s).length > maxChars || s.length > maxChars + count * MEDIA_LINE_ROOM;
}

// The longest any grouped message can be, for the cheap check that runs
// before the channel is known.
function ceiling(maxChars) {
  return maxChars + MAX_GROUP_MEDIA * MEDIA_LINE_ROOM;
}

// Why a plaintext message carrying uploads cannot go out, or null.
function refusal(content, { maxChars, maxAttachments, forumTopic = false } = {}) {
  const limit = groupLimit({ maxAttachments, forumTopic });
  if (mediaCount(content) > limit) return `Too many attachments in one message (max ${limit})`;
  if (tooLong(content, maxChars)) return `Message too long (max ${maxChars} characters)`;
  return null;
}

module.exports = {
  MAX_GROUP_MEDIA,
  MEDIA_GROUP_LAYOUTS,
  FORUM_TOPIC_MEDIA,
  MEDIA_LINE_ROOM,
  isMediaLine,
  mediaLines,
  mediaCount,
  typedText,
  isMediaOnly,
  hasMedia,
  groupLimit,
  tooLong,
  ceiling,
  refusal,
};

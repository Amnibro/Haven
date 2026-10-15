'use strict';

// Imported Discord reactions get the same check as a live reaction: a
// Unicode emoji or a :custom_name:, nothing that could carry markup.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseDiscordExport, isReactionEmoji } = require('../src/importDiscord');

test('isReactionEmoji accepts emoji and custom names only', () => {
  assert.equal(isReactionEmoji('👍'), true);
  assert.equal(isReactionEmoji('❓'), true);
  assert.equal(isReactionEmoji('👍🏽'), true);
  assert.equal(isReactionEmoji(':party_blob:'), true);
  assert.equal(isReactionEmoji('<img src=x onerror=alert(1)>'), false);
  assert.equal(isReactionEmoji('pepe'), false);
  assert.equal(isReactionEmoji(''), false);
  assert.equal(isReactionEmoji(null), false);
  assert.equal(isReactionEmoji('👍'.repeat(20)), false);
});

test('DiscordChatExporter import drops reactions that fail the check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-react-'));
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify({
    guild: { name: 'G' },
    channel: { id: '1', name: 'general' },
    messages: [{
      id: '100', content: 'hi', timestamp: '2026-01-01T00:00:00Z',
      author: { id: '5', name: 'a' },
      reactions: [
        { emoji: { name: '👍' }, count: 2 },
        { emoji: { name: '"><img src=x onerror=alert(1)>' }, count: 1 },
      ],
    }],
  }));
  try {
    const out = parseDiscordExport(file);
    assert.deepEqual(out.channels[0].messages[0].reactions, [{ emoji: '👍', count: 2 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

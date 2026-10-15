'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanWebhookName, cleanWebhookAvatarUrl } = require('../src/webhookFields');

test('bot avatars are uploads or https links only', () => {
  assert.equal(cleanWebhookAvatarUrl('/uploads/abc-123.png'), '/uploads/abc-123.png');
  assert.equal(cleanWebhookAvatarUrl('  https://cdn.example.com/a.png  '), 'https://cdn.example.com/a.png');
  for (const bad of [
    'http://example.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//evil.example/a.png',
    'https://user:pass@example.com/a.png',
    '/uploads/../server.js',
    '/uploads/a/../../b.png',
    '/uploads/a.png?x=1',
    '/etc/passwd',
    'https://example.com/' + 'a'.repeat(600),
    '',
    null,
    42,
  ]) {
    assert.equal(cleanWebhookAvatarUrl(bad), null, String(bad));
  }
});

test('bot names lose control characters, angle brackets and excess length', () => {
  assert.equal(cleanWebhookName('  Helper  '), 'Helper');
  assert.equal(cleanWebhookName('Bad\u0000‮Bot<script>'), 'BadBotscript');
  assert.equal(cleanWebhookName('x'.repeat(50)).length, 32);
  assert.equal(Array.from(cleanWebhookName('😀'.repeat(40))).length, 32);
  assert.equal(cleanWebhookName('\u0007'), '');
  assert.equal(cleanWebhookName(undefined), '');
});

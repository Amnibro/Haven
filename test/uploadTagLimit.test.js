'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { MAX_TAGS_CEIL, MAX_TAGS_PER_ATTACHMENT, effectiveLimits } = require('../src/uploadTags');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const limitsWith = (value) => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT)');
  if (value !== undefined) db.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?)').run('max_tags_per_attachment', String(value));
  const limits = effectiveLimits(db);
  db.close();
  return limits.maxTags;
};
test('an attachment can carry up to 20 upload tags when the admin allows it (#5790)', () => {
  assert.equal(MAX_TAGS_CEIL, 20);
  assert.equal(limitsWith(20), 20);
  assert.equal(limitsWith(50), 20);
  assert.equal(limitsWith(0), 1);
  assert.equal(limitsWith(), MAX_TAGS_PER_ATTACHMENT);
});
test('the admin form, the save path and the client clamp agree with the server ceiling', () => {
  assert.match(read('public/app.html'), new RegExp(`id="max-tags-per-attachment" min="1" max="${MAX_TAGS_CEIL}"`));
  assert.match(read('src/socketHandlers/admin.js'), new RegExp(`key === 'max_tags_per_attachment'\\) \\{ const n = parseInt\\(value\\); if \\(isNaN\\(n\\) \\|\\| n < 1 \\|\\| n > ${MAX_TAGS_CEIL}\\) return; \\}`));
  assert.match(read('src/serverTemplate.js'), new RegExp(`max_tags_per_attachment: N\\(1, ${MAX_TAGS_CEIL}\\)`));
  assert.match(read('public/js/modules/app-admin.js'), new RegExp(`Math\\.min\\(${MAX_TAGS_CEIL}, parseInt\\(document\\.getElementById\\('max-tags-per-attachment'\\)`));
  assert.match(read('public/js/modules/app-attachments.js'), new RegExp(`Math\\.max\\(1, Math\\.min\\(${MAX_TAGS_CEIL}, n\\)\\) : 3`));
  assert.match(JSON.parse(read('public/locales/en.json')).settings.admin.max_tags_per_attachment_hint, new RegExp(`1 to ${MAX_TAGS_CEIL}`));
});

'use strict';

// Each picture of several sent together keeps its own upload tags (#5799):
// tagged one by one at send time, edited one by one from the media gallery,
// and an edit of the whole message changes the set without flattening it.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const tags = require('../src/uploadTags');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE upload_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE, created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE attachment_tags (message_id INTEGER NOT NULL, rel_path TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (message_id, rel_path, tag_id));
  `);
  return db;
}
const A = '/uploads/1760000000000-aaaaaaaa.png';
const B = '/uploads/1760000000000-bbbbbbbb.png';
const C = '/uploads/1760000000000-cccccccc.pdf';
const CONTENT = ['Weekend', A, `spoiler-img:${B}`, `[file:notes.pdf](${C}|2 KB)`].join('\n');
const base = { messageId: 1, content: CONTENT, userId: 7, canCreate: true, maxTags: 3, maxLen: 20 };

test('every upload a message names is found, once, in order', () => {
  assert.deepEqual(tags.extractUploadPaths(CONTENT), [A, B, C]);
  assert.deepEqual(tags.extractUploadPaths(`${A}\n${A}`), [A]);
  assert.deepEqual(tags.extractUploadPaths('no files'), []);
});

test('each file is tagged with its own set at send time', () => {
  const db = freshDb();
  const applied = tags.applyTagsToFiles(db, {
    ...base,
    perFile: [
      { url: A, tags: ['beach', 'sun'] },
      { url: B, tags: ['night'] },
      { url: '/uploads/not-in-this-message.png', tags: ['stolen'] },
      { url: A, tags: ['twice'] },
    ],
  });
  assert.deepEqual(applied.sort(), ['beach', 'night', 'sun']);
  assert.deepEqual(tags.fileTags(db, 1, A), ['beach', 'sun']);
  assert.deepEqual(tags.fileTags(db, 1, B), ['night']);
  assert.deepEqual(tags.fileTags(db, 1, C), []);
  assert.deepEqual(tags.messageTags(db, 1), ['beach', 'night', 'sun']);
});

test('each file has its own cap, not one cap for the whole message', () => {
  const db = freshDb();
  tags.applyTagsToFiles(db, { ...base, perFile: [{ url: A, tags: ['a1', 'a2', 'a3', 'a4'] }, { url: B, tags: ['b1', 'b2', 'b3'] }] });
  assert.deepEqual(tags.fileTags(db, 1, A), ['a1', 'a2', 'a3']);
  assert.deepEqual(tags.fileTags(db, 1, B), ['b1', 'b2', 'b3']);
});

test('the gallery replaces one file\'s set and leaves the others alone', () => {
  const db = freshDb();
  tags.applyTagsToFiles(db, { ...base, perFile: [{ url: A, tags: ['beach'] }, { url: B, tags: ['night'] }] });
  tags.setMessageTags(db, { ...base, tagNames: ['sunset'], relPath: B });
  assert.deepEqual(tags.fileTags(db, 1, A), ['beach']);
  assert.deepEqual(tags.fileTags(db, 1, B), ['sunset']);
  assert.deepEqual(tags.setMessageTags(db, { ...base, tagNames: ['x'], relPath: '/uploads/elsewhere.png' }), []);
  assert.deepEqual(tags.fileTags(db, 1, A), ['beach'], 'a file the message does not name changes nothing');
});

test('editing the whole message keeps each picture\'s own tags', () => {
  const db = freshDb();
  tags.applyTagsToFiles(db, { ...base, perFile: [{ url: A, tags: ['beach', 'sun'] }, { url: B, tags: ['night'] }] });
  // The editor shows beach, night, sun; the person removes sun and adds trip.
  const result = tags.setMessageTags(db, { ...base, tagNames: ['beach', 'night', 'trip'] });
  assert.deepEqual(result, ['beach', 'night', 'trip']);
  assert.deepEqual(tags.fileTags(db, 1, A), ['beach', 'trip']);
  assert.deepEqual(tags.fileTags(db, 1, B), ['night', 'trip']);
  assert.deepEqual(tags.fileTags(db, 1, C), ['trip']);
  // Clearing the set clears every file.
  assert.deepEqual(tags.setMessageTags(db, { ...base, tagNames: [] }), []);
  assert.deepEqual(tags.messageTags(db, 1), []);
});

test('a message with one file behaves as it always has', () => {
  const db = freshDb();
  const one = { ...base, content: A };
  tags.applyTagsToMessage(db, { ...one, tagNames: ['old'] });
  assert.deepEqual(tags.setMessageTags(db, { ...one, tagNames: ['new', 'two'] }), ['new', 'two']);
  assert.deepEqual(tags.fileTags(db, 1, A), ['new', 'two']);
});

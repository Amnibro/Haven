'use strict';

// Up in an empty thread reply box edits your newest reply in that thread,
// as Up does in the channel's message box.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let T;
test.before(async () => {
  T = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-threads.js')).href)).default;
});
test.afterEach(() => { delete global.document; });

const row = (id, userId, editing = false) => ({
  dataset: { msgId: String(id), userId: String(userId) },
  classList: { contains: (c) => c === 'editing' && editing },
  scrollIntoView() { this.scrolled = true; },
});

function setup(rows) {
  global.document = { getElementById: (id) => (id === 'thread-messages' ? { querySelectorAll: () => rows } : null) };
  const edits = [];
  const app = Object.assign(Object.create(null), T, { user: { id: 5 }, _startEditMessage: (el, id) => edits.push(id) });
  return { app, edits };
}

test('it edits your newest reply, skipping everyone else\'s', () => {
  const rows = [row(1, 5), row(2, 7), row(3, 5), row(4, 7)];
  const { app, edits } = setup(rows);
  assert.equal(app._editLastThreadMessage(), true);
  assert.deepEqual(edits, [3]);
  assert.equal(rows[2].scrolled, true, 'the reply being edited is brought into view');
});

test('a reply already being edited is passed over', () => {
  const { app, edits } = setup([row(1, 5), row(3, 5, true)]);
  app._editLastThreadMessage();
  assert.deepEqual(edits, [1]);
});

test('with no reply of yours there is nothing to edit and the key is left alone', () => {
  const { app, edits } = setup([row(2, 7)]);
  assert.equal(app._editLastThreadMessage(), false);
  assert.deepEqual(edits, []);
});

test('the thread box wires Up, honouring the same setting as the channel', () => {
  const src = read('public/js/modules/app-pip-panels.js');
  assert.match(src, /e\.key === 'ArrowUp' && !threadInput\.value/);
  assert.match(src, /localStorage\.getItem\('haven_up_arrow_edit'\) !== 'false' && this\._editLastThreadMessage\(\)/);
});

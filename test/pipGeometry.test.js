'use strict';

// Pop-outs (DM and thread PiP) stay on screen when the window shrinks, but
// only the user's own drag or resize changes the size and spot that are saved.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

let fitPiPRect, rectToSave;
test.before(async () => {
  ({ fitPiPRect, rectToSave } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/modules/pip-geometry.js')).href));
});

const DM = { minW: 320, maxW: 720, minH: 280, width: 420, height: 540, gapX: 20, gapY: 80 };
const dm = (saved, viewW, viewH) => fitPiPRect(saved, { ...DM, viewW, viewH });
const saved = { left: 900, top: 200, width: 600, height: 640 };

test('a small window squeezes the pop-out onto the screen', () => {
  assert.deepEqual(dm(saved, 700, 500), { left: 100, top: 28, width: 600, height: 472 });
  assert.deepEqual(dm(saved, 1600, 1000), saved);
});

test('the squeeze is not saved, so the saved rect comes back when the window grows', () => {
  const small = dm(saved, 700, 500);
  // Dragging while squeezed saves the new spot but keeps the saved size.
  const moved = rectToSave(saved, { ...small, left: 50, top: 10 }, 'move');
  assert.deepEqual(moved, { left: 50, top: 10, width: 600, height: 640 });
  assert.deepEqual(dm(moved, 1600, 1000), moved);
  // Resizing while squeezed saves the new size but keeps the saved spot.
  const resized = rectToSave(saved, { ...small, width: 500, height: 400 }, 'resize');
  assert.deepEqual(resized, { left: 900, top: 200, width: 500, height: 400 });
});

test('with nothing saved yet, the first drag or resize saves the whole rect', () => {
  const now = { left: 10.4, top: 20.6, width: 420, height: 540 };
  assert.deepEqual(rectToSave(null, now, 'move'), { left: 10, top: 21, width: 420, height: 540 });
  assert.deepEqual(rectToSave(null, now, 'resize'), { left: 10, top: 21, width: 420, height: 540 });
  assert.deepEqual(dm(null, 1600, 1000), { left: 1160, top: 380, width: 420, height: 540 });
});

'use strict';

// The theme picker gallery: preview colours from the server, the picker's
// own logic (search, sections, who sees what) and who may publish.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { parseThemeMetadata, readThemeMetadataSnapshot, themeSwatch } = require('../src/themeMetadata');

const ROOT = path.join(__dirname, '..');

test('a palette theme carries its preview colours', () => {
  const meta = parseThemeMetadata(`/** @name Neon */
:root { --bg-primary: #03070d; --bg-secondary:#06101a; --accent-hover: #fff; --accent: rgb(0, 229, 255); --text-primary: #e8fbff; }`);
  assert.deepEqual(meta.swatch, { bg: '#03070d', panel: '#06101a', accent: 'rgb(0, 229, 255)', text: '#e8fbff' });
});

test('preview colours take only plain colour values', () => {
  assert.equal(themeSwatch(':root { --bg-primary: var(--x); }'), null);
  assert.equal(themeSwatch(':root { --bg-primary: url(https://example.test/a.png); }'), null);
  assert.deepEqual(
    themeSwatch(':root { --bg-primary: #000; --accent: expression(alert(1)); --text-primary: #fff" onload="x; }'),
    { bg: '#000' },
  );
  // A token whose name only ends in --bg-primary is not the palette's own.
  assert.equal(themeSwatch(':root { --braid-bg-primary: #123456; }'), null);
  assert.equal(themeSwatch(null), null);
});

test('every bundled theme has preview colours', () => {
  for (const theme of readThemeMetadataSnapshot(path.join(ROOT, 'themes'))) {
    assert.ok(theme.swatch?.bg && theme.swatch?.accent, `${theme.file} has no preview colours`);
  }
});

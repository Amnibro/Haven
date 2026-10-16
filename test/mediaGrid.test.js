'use strict';

// Pictures sent together show as one grid (#5799). The layout by count, the
// line reading and the grid markup are pure, so they are driven here; the
// look was checked in a browser.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let M, MAX;
test.before(async () => {
  global.t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  const mod = await import(pathToFileURL(path.join(ROOT, 'public/js/modules/app-media-grid.js')).href);
  M = mod.default;
  MAX = mod.MEDIA_GROUP_MAX;
});

const area = (layout) => layout.spans.reduce((sum, [c, r]) => sum + c * r, 0);

test('one picture is not a grid', () => {
  assert.equal(M._mediaGridLayout(0), null);
  assert.equal(M._mediaGridLayout(1), null);
});

test('every count fills its grid with no gaps', () => {
  for (let n = 2; n <= 30; n++) {
    const l = M._mediaGridLayout(n);
    assert.equal(l.spans.length, l.shown, `count ${n}`);
    assert.equal(area(l), 6 * l.rows, `count ${n} covers six columns by ${l.rows} rows`);
    assert.match(l.ratio, /^\d+ \/ \d+$/);
  }
});

test('the layouts follow the count', () => {
  assert.deepEqual(M._mediaGridLayout(2).spans, [[3, 1], [3, 1]], 'two side by side');
  assert.deepEqual(M._mediaGridLayout(3).spans, [[3, 2], [3, 1], [3, 1]], 'one large and two stacked');
  assert.deepEqual(M._mediaGridLayout(4).spans, [[3, 1], [3, 1], [3, 1], [3, 1]], 'two by two');
  for (const n of [5, 6]) assert.ok(M._mediaGridLayout(n).spans.some(([c]) => c === 2), `${n}: three columns`);
  assert.equal(M._mediaGridLayout(6).rows, 2);
  for (const n of [7, 8, 9]) assert.equal(M._mediaGridLayout(n).rows, 3, `${n}: three rows`);
  assert.deepEqual(M._mediaGridLayout(9).spans, Array(9).fill([2, 1]), 'nine is three by three');
});

test('past nine, eight show and the ninth says how many more', () => {
  assert.deepEqual([M._mediaGridLayout(9).shown, M._mediaGridLayout(9).more], [9, 0]);
  assert.deepEqual([M._mediaGridLayout(10).shown, M._mediaGridLayout(10).more], [9, 2]);
  assert.deepEqual([M._mediaGridLayout(12).shown, M._mediaGridLayout(12).more], [9, 4]);
});

test('grid lines are pictures, encrypted pictures and videos', () => {
  assert.equal(M._mediaGridKind('/uploads/1760-abc.png'), 'image');
  assert.equal(M._mediaGridKind('spoiler-img:/uploads/1760-abc.webp'), 'image');
  assert.equal(M._mediaGridKind('e2e-img:image/jpeg:/uploads/1760-abc.enc'), 'image');
  assert.equal(M._mediaGridKind('spoiler-img:e2e-img:image/png:/uploads/1760-abc.enc'), 'image');
  assert.equal(M._mediaGridKind('[file:clip.mp4](/uploads/1760-abc.mp4|3.1 MB)'), 'video');
  assert.equal(M._mediaGridKind('[file:notes.pdf](/uploads/1760-abc.pdf|3.1 MB)'), null);
  assert.equal(M._mediaGridKind('/uploads/1760-abc.zip'), null);
  assert.equal(M._mediaGridKind('hello'), null);
  assert.equal(M._mediaGridKind('https://example.com/a.png'), null);
  assert.deepEqual(M._mediaGridRun(['a', '/uploads/1.png', '/uploads/2.png', 'b'], 1), ['/uploads/1.png', '/uploads/2.png']);
});

test('a batch is ordered pictures and videos first, then split by ten', () => {
  const f = (name, type) => ({ name, type });
  const files = [f('a.pdf', 'application/pdf'), f('b.png', 'image/png'), f('c.mp4', 'video/mp4'), f('d.mov', ''), f('e.zip', 'application/zip')];
  assert.deepEqual(M._mediaGroupOrder(files).map(x => x.name), ['b.png', 'c.mp4', 'd.mov', 'a.pdf', 'e.zip']);
  assert.equal(MAX, 10);
  const twelve = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(M._mediaChunks(twelve, 10).map(c => c.length), [10, 2]);
  assert.deepEqual(M._mediaChunks(twelve, 3).map(c => c.length), [3, 3, 3, 3]);
  assert.equal(M._mediaGroupMax.call({ _maxAttachments: () => 50 }), 10);
  assert.equal(M._mediaGroupMax.call({ _maxAttachments: () => 3 }), 3);
});

test('editing a batch edits its text and keeps its pictures', () => {
  const split = (c) => M._mediaGroupSplit.call(M, c);
  assert.deepEqual(split('hi there\n/uploads/1.png\n/uploads/2.png'), { text: 'hi there', media: ['/uploads/1.png', '/uploads/2.png'] });
  assert.deepEqual(split('/uploads/1.png\n[file:a.pdf](/uploads/a.pdf|1 KB)'), { text: '', media: ['/uploads/1.png', '[file:a.pdf](/uploads/a.pdf|1 KB)'] });
  assert.equal(split('/uploads/1.png'), null, 'one picture edits as before');
  assert.equal(split('a\n/uploads/1.png\nb\n/uploads/2.png'), null, 'text between pictures edits as before');
  assert.equal(split('just text'), null);
});

test('the grid markup: spans, +N, hidden extras and video tiles', () => {
  const ctx = Object.assign(Object.create(M), {
    _escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    _formatContent: (l) => `<img class="chat-image" data-line="${l}">`,
  });
  const lines = Array.from({ length: 12 }, (_, i) => `/uploads/${i}.png`);
  lines[1] = '[file:clip.mp4](/uploads/clip.mp4|1 MB)';
  const html = ctx._mediaGridHtml(lines);
  assert.match(html, /^<div class="media-grid" data-count="12"/);
  assert.match(html, /aspect-ratio:1 \/ 1;grid-template-rows:repeat\(3,minmax\(0,1fr\)\)/);
  assert.equal((html.match(/class="media-grid-tile[^"]*mg-hidden/g) || []).length, 3, 'three wait behind the +N');
  assert.equal((html.match(/media-grid-more/g) || []).length, 1);
  assert.match(html, />\+4<\/span>/);
  assert.match(html, /class="media-grid-tile is-video" style="grid-column:span 2;grid-row:span 1" data-video-src="\/uploads\/clip\.mp4"/);
  assert.equal((html.match(/class="chat-image"/g) || []).length, 11, 'every picture is in the grid for the lightbox');
});

test('the grid is loaded with the app and its styles sit in their own file', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import MediaGridMethods from '\.\/modules\/app-media-grid\.js\?v=[0-9.]+';/);
  assert.match(app, /^\s*MediaGridMethods,$/m);
  assert.match(app, /this\._setupMediaGrid\(\);/);
  assert.match(read('public/css/style.css'), /@import url\('\/css\/style-media-grid\.css\?v=[0-9.]+'\);/);
  const content = read('public/js/modules/app-message-content.js');
  assert.match(content, /this\._mediaGridHtml\(run\)/);
  assert.match(read('public/js/modules/app-media.js'), /this\._lightboxScope = \(imgEl && imgEl\.closest && imgEl\.closest\('\.media-grid'\)\) \|\| null;/);
  assert.match(read('public/js/modules/app-forum.js'), /this\._mediaGridOff = !!this\._forumBlogOn\?\.\(\);/);
});

test('text goes with the attachments unless it is a command, a burn message or text is off', () => {
  const app = Object.assign(Object.create(M), { channels: [{ code: 'aaaaaaaa' }, { code: 'bbbbbbbb', text_enabled: 0 }] });
  assert.equal(app._mediaGroupTakesText('look at these', { code: 'aaaaaaaa' }), true);
  assert.equal(app._mediaGroupTakesText('', { code: 'aaaaaaaa' }), false);
  assert.equal(app._mediaGroupTakesText('/shrug', { code: 'aaaaaaaa' }), false);
  assert.equal(app._mediaGroupTakesText('gone soon', { code: 'aaaaaaaa', burnSeconds: 30 }), false);
  assert.equal(app._mediaGroupTakesText('caption', { code: 'bbbbbbbb' }), false);
  assert.equal(Object.assign(Object.create(M), { _forumBlogOn: () => true })._mediaGroupOn('x'), false, 'a blog keeps one piece per file');
  assert.equal(M._mediaGroupOn('x'), true);
});

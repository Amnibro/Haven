'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = require('./coreCss').readCoreCss();
test('the thread paperclip opens the file picker and queues what was picked', () => {
  const pip = read('public/js/modules/app-pip-panels.js');
  assert.match(read('public/app.html'), /id="thread-upload-btn"/);
  assert.match(pip, /getElementById\('thread-upload-btn'\)\?\.addEventListener\('click'/);
  assert.match(pip, /threadFileInput\?\.addEventListener\('change'[^\n]*_queueThreadFiles\(threadFileInput\.files\)/);
});
test('decrypted DM pictures that are not plain raster images are redrawn before display', () => {
  assert.match(read('public/js/modules/app-platform.js'), /new Blob\(\[plain\], \{ type: mime \}\)\)\n\s*\.then\(blob => this\._inertImageBlob \? this\._inertImageBlob\(blob\) : blob\)/);
});
test('a still frame waits for decode and refuses a blank first frame', () => {
  const src = read('public/js/modules/app-appearance.js');
  assert.match(src, /im\.decode\(\)\.then\(paint/);
  assert.match(src, /getImageData\(0, 0, Math\.min\(c\.width, 8\), Math\.min\(c\.height, 8\)\)/);
});
test('the empty DM list and the guest DM button keep their styling', () => {
  assert.match(css, /\.dm-empty \{ padding: 0\.75rem 0\.5rem;/);
  assert.match(css, /body\.is-guest #dm-dock-btn \{ display: none !important; \}/);
});
test('forum board strings are translated in Portuguese', () => {
  const pt = JSON.parse(read('public/locales/pt.json'));
  for (const k of ['status_planned', 'status_in_progress', 'kind_bug', 'kind_feature', 'back_to_topics']) assert.ok(pt.forum[k], `pt forum.${k}`);
});

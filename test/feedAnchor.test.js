'use strict';

// The chat feed keeps the reader's place while messages change height. The
// behaviour itself was checked in a real browser; this guards the wiring.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the feed anchor is loaded and started with the app', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import FeedAnchorMethods from '\.\/modules\/app-feed-anchor\.js\?v=[0-9.]+';/);
  assert.match(app, /^\s*FeedAnchorMethods,$/m);
  assert.match(app, /this\._setupFeedAnchor\(\);/);
});

test('it follows the bottom, holds the reader otherwise, and leaves history loading alone', () => {
  const src = read('public/js/modules/app-feed-anchor.js');
  assert.match(src, /new ResizeObserver/);
  assert.match(src, /if \(this\._suppressCoupleCheck\) return;/);
  assert.match(src, /this\._coupledToBottom && this\._noMoreFuture !== false/);
  assert.match(src, /sc\.scrollTop \+= drift;/);
});

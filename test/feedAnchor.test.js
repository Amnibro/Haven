'use strict';

// The chat feed keeps the reader's place while messages change height. The
// behaviour itself was checked in a real browser; this guards the wiring and
// drives the pure rule for staying at the bottom.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', 'app-feed-anchor.js');
let M;
test.before(async () => {
  M = (await import(pathToFileURL(modulePath).href)).default;
});

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
  assert.match(src, /this\._noMoreFuture !== false && !this\._isForumFeed\?\.\(\)/);
  assert.match(src, /sc\.scrollTop \+= drift;/);
});

test('threads, forum topics and the DM window are watched too', () => {
  const src = read('public/js/modules/app-feed-anchor.js');
  assert.match(src, /\['thread-messages', 'dm-pip-messages'\]/);
});

test('a coupled feed always stays at the bottom', () => {
  assert.equal(M._feedShouldStick({ live: true, coupled: true, gapBefore: 900, startsAtEnd: true }), true);
});

test('a feed at the bottom stays there even when the flag missed it', () => {
  assert.equal(M._feedShouldStick({ live: true, coupled: false, gapBefore: 0, startsAtEnd: true }), true);
  assert.equal(M._feedShouldStick({ live: true, coupled: false, gapBefore: 40, startsAtEnd: true }), true);
});

test('a reader scrolled up into history is not pulled down', () => {
  assert.equal(M._feedShouldStick({ live: true, coupled: false, gapBefore: 41, startsAtEnd: true }), false);
  assert.equal(M._feedShouldStick({ live: true, coupled: false, gapBefore: 500, startsAtEnd: true }), false);
});

test('a trimmed window or a forum feed never sticks', () => {
  assert.equal(M._feedShouldStick({ live: false, coupled: true, gapBefore: 0, startsAtEnd: true }), false);
});

test('a blog topic sticks only once the reader has scrolled to its end', () => {
  assert.equal(M._feedShouldStick({ live: true, coupled: false, gapBefore: 0, startsAtEnd: false, scrolled: false }), false);
  assert.equal(M._feedShouldStick({ live: true, coupled: false, gapBefore: 0, startsAtEnd: false, scrolled: true }), true);
});

test('the gap before a change takes the growth back out', () => {
  // At the bottom of 1000px of content in a 400px box, then a 27px row.
  const sc = { scrollHeight: 1027, scrollTop: 600, clientHeight: 400 };
  assert.equal(M._feedGapBefore(sc, 27, 600), 0);
  assert.equal(M._feedGapBefore(sc, 27), 0, 'no earlier reading: the scroll as it is now');
});

test('a scroll moved by something else does not count as being at the bottom', () => {
  // 300px from the end; a picture above grew 280px and the loader held the
  // reader's place by scrolling 280px down. Only the last seen scroll shows
  // the reader was never at the bottom.
  const sc = { scrollHeight: 1280, scrollTop: 580, clientHeight: 400 };
  assert.equal(M._feedGapBefore(sc, 280, 300), 300);
});

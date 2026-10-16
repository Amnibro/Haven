'use strict';

// Clicking a reply line jumps to the message it answers and flashes it, in a
// thread as in the channel, and a picture taller than the list lines up its
// top so the picture comes into view. Measured in a real browser too.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let A;
test.before(async () => {
  A = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-feed-anchor.js')).href)).default;
  global.requestAnimationFrame = () => 0;
});
test.after(() => { delete global.requestAnimationFrame; });

function jump(msgHeight, listHeight) {
  const calls = [];
  const sc = { clientHeight: listHeight, addEventListener() {}, removeEventListener() {} };
  const el = {
    isConnected: true,
    closest: () => sc,
    getBoundingClientRect: () => ({ top: 0, height: msgHeight }),
    scrollIntoView: (o) => calls.push(o.block),
  };
  Object.assign(Object.create(null), A)._scrollToMessage(el);
  return calls[0];
}

test('a message that fits is brought to the middle', () => {
  assert.equal(jump(176, 600), 'center');
});

test('a picture taller than the list lines up its top', () => {
  assert.equal(jump(176, 134), 'start');
  assert.equal(jump(900, 600), 'start');
});

test('a reply line in a thread flashes its target as the channel does', () => {
  const src = read('public/js/modules/app-message-actions.js');
  const thread = src.slice(src.indexOf("const banner = e.target.closest('.reply-banner');\n      if (banner) {"));
  assert.match(thread, /this\._scrollToMessage\(target\);[\s\S]{0,200}target\.classList\.add\('highlight-flash'\);/);
  assert.doesNotMatch(src, /thread-highlight/);
});

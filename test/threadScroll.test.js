'use strict';

// The thread panel follows new replies only for a reader at the bottom. The
// behaviour was measured in a real browser; this drives the rule.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const mod = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', f)).href;
let Scroll, Anchor;
test.before(async () => {
  Scroll = (await import(mod('app-thread-scroll.js'))).default;
  Anchor = (await import(mod('app-feed-anchor.js'))).default;
});

// A thread box with 2000px of replies in a 600px panel, after a 100px reply
// was added at the end.
function setup({ scrollTop, blog = false }) {
  const box = { scrollHeight: 2100, scrollTop, clientHeight: 600 };
  const classes = new Set();
  const btn = { title: '', classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const label = { textContent: '' };
  global.document = { getElementById: (id) => ({ 'thread-messages': box, 'thread-jump-latest': btn, 'thread-jump-count': label }[id] || null) };
  global.t = (k, v) => `${k}:${v ? v.count : ''}`;
  const app = Object.assign(Object.create(null), Anchor, Scroll, { user: { id: 1 }, _forumBlogThread: blog ? {} : null, _threadUnseen: 0 });
  const gapBefore = 2000 - scrollTop - 600;
  return { app, box, classes, label, gapBefore };
}
test.afterEach(() => { delete global.document; delete global.t; });

test('a reader at the bottom follows the new reply', () => {
  const { app, box, gapBefore } = setup({ scrollTop: 1400 });
  app._threadAfterLiveReply(box, gapBefore, { user_id: 2 });
  assert.equal(box.scrollTop, 2100);
  assert.equal(app._threadUnseen, 0);
});

test('within 40px of the end still counts as the bottom', () => {
  const { app, box, gapBefore } = setup({ scrollTop: 1360 });
  assert.equal(gapBefore, 40);
  app._threadAfterLiveReply(box, gapBefore, { user_id: 2 });
  assert.equal(box.scrollTop, 2100);
});

test('a reader scrolled up is never moved, and the reply is counted', () => {
  for (const top of [0, 300, 1359]) {
    const { app, box, classes, label, gapBefore } = setup({ scrollTop: top });
    app._threadAfterLiveReply(box, gapBefore, { user_id: 2 });
    app._threadAfterLiveReply(box, gapBefore, { user_id: 3 });
    assert.equal(box.scrollTop, top, `scrollTop ${top} stays put`);
    assert.equal(app._threadUnseen, 2);
    assert.ok(classes.has('visible') && classes.has('has-count'));
    assert.equal(label.textContent, 'thread_runtime.new_replies_other:2');
  }
});

test('your own reply always takes you to the bottom', () => {
  const { app, box, gapBefore } = setup({ scrollTop: 0 });
  app._threadAfterLiveReply(box, gapBefore, { user_id: 1 });
  assert.equal(box.scrollTop, 2100);
  assert.equal(app._threadUnseen, 0);
});

test('a blog topic opened at its top is not pulled to the end', () => {
  const { app, box } = setup({ scrollTop: 0, blog: true });
  // A short post: everything fits, so the gap is 0, but the reader never
  // scrolled; the rule for blog topics keeps them at the top.
  app._threadAfterLiveReply(box, 0, { user_id: 2 });
  assert.equal(box.scrollTop, 0);
});

test('jumping to the latest clears the count and hides the button', () => {
  const { app, box, classes, gapBefore } = setup({ scrollTop: 0 });
  app._threadAfterLiveReply(box, gapBefore, { user_id: 2 });
  app._threadJumpToLatest();
  assert.equal(box.scrollTop, 2100);
  assert.equal(app._threadUnseen, 0);
  box.scrollTop = 1500; // the end of 2100 in a 600px panel
  app._updateThreadJump();
  assert.equal(classes.has('visible'), false);
});

test('only a live reply goes through the rule; loading a thread lands at its end', () => {
  const threads = read('public/js/modules/app-threads.js');
  assert.match(threads, /_appendThreadMessage\(msg, opts = \{\}\)/);
  assert.match(threads, /if \(opts\.live && this\._threadAfterLiveReply\) this\._threadAfterLiveReply\(container, gapBefore, msg\);\n\s*else container\.scrollTop = container\.scrollHeight;/);
  const ev = read('public/js/modules/app-socket-events.js');
  assert.match(ev, /this\._appendThreadMessage\(data\.message, \{ live: true \}\);/);
  assert.match(ev, /this\._resetThreadJump\?\.\(\);/);
  assert.match(read('public/app.html'), /id="thread-jump-latest"/);
  const app = read('public/js/app.js');
  assert.match(app, /import ThreadScrollMethods from '\.\/modules\/app-thread-scroll\.js\?v=[0-9.]+';/);
  assert.match(app, /this\._setupThreadScroll\(\);/);
});

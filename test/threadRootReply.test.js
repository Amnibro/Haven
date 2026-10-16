'use strict';

// A thread reply that "replies" to the thread's own first message shows no
// reply banner, and the server stops storing it that way outside blogs.

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
const app = (extra = {}) => Object.assign(Object.create(null), T, { _activeThreadParent: 40, _forumBlogThread: null }, extra);

test('a reply to the thread root is recognised, from the open thread or the message', () => {
  assert.equal(app()._isThreadRootReply({ reply_to: 40 }), true);
  assert.equal(app()._isThreadRootReply({ reply_to: '40' }), true);
  assert.equal(app({ _activeThreadParent: null })._isThreadRootReply({ reply_to: 7, thread_id: 7 }), true);
});

test('replies to other messages in the thread keep their banner', () => {
  assert.equal(app()._isThreadRootReply({ reply_to: 41 }), false);
  assert.equal(app()._isThreadRootReply({ reply_to: null }), false);
  assert.equal(app()._isThreadRootReply({}), false);
});

test('in a blog a reply to the root is a comment on the first picture and stays', () => {
  assert.equal(app({ _forumBlogThread: {} })._isThreadRootReply({ reply_to: 40 }), false);
});

test('the thread panel drops the banner and groups such replies like plain ones', () => {
  const src = read('public/js/modules/app-threads.js');
  assert.match(src, /const replyHtml = msg\.replyContext && !toRoot \? this\._renderReplyBanner\(msg\.replyContext\) : '';/);
  assert.match(src, /\(!msg\.reply_to \|\| toRoot\)/);
});

test('the server stores no reply to the thread root outside a blog', () => {
  const src = read('src/socketHandlers/messages.js');
  assert.match(src, /if \(replyTo === parentId && !forumBlog\.blogOn\(db, channel\.id\)\) replyTo = null;/);
});

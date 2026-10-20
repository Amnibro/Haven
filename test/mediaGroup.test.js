'use strict';

// Pictures sent together arrive as one message (#5799). These check the rules
// the server holds such a message to (src/mediaGroup.js): how upload lines are
// read, how many files one message carries, the typed length, and the channel
// switches.

const assert = require('node:assert/strict');
const test = require('node:test');
const mg = require('../src/mediaGroup');

const pic = (n) => `/uploads/1760000000000-${String(n).padStart(8, '0')}.png`;
const file = (n) => `[file:report ${n}.pdf](/uploads/1760000000000-f${String(n).padStart(7, '0')}.pdf|1.2 MB)`;

test('upload lines are pictures, spoiler pictures and file lines, nothing else', () => {
  assert.ok(mg.isMediaLine(pic(1)));
  assert.ok(mg.isMediaLine(`spoiler-img:${pic(1)}`));
  assert.ok(mg.isMediaLine('/uploads/images/cat.webp'));
  assert.ok(mg.isMediaLine(`  ${file(1)}  `));
  assert.ok(mg.isMediaLine(`spoiler-img:${file(2)}`), 'a video sent as a spoiler');
  assert.ok(!mg.isMediaLine('look at /uploads/x.png'));
  assert.ok(!mg.isMediaLine('/uploads/x.png and more'));
  assert.ok(!mg.isMediaLine('https://example.com/x.png'));
  assert.ok(!mg.isMediaLine('[file:x](https://example.com/x.pdf|1 KB)'));
  assert.ok(!mg.isMediaLine(''));
});

test('a grouped message splits into its text and its uploads', () => {
  const content = ['Trip photos', 'day one', pic(1), `spoiler-img:${pic(2)}`, file(3)].join('\n');
  assert.equal(mg.mediaCount(content), 3);
  assert.deepEqual(mg.mediaLines(content), [pic(1), `spoiler-img:${pic(2)}`, file(3)]);
  assert.equal(mg.typedText(content), 'Trip photos\nday one');
  assert.ok(!mg.isMediaOnly(content));
  assert.ok(mg.hasMedia(content));
  assert.ok(mg.isMediaOnly([pic(1), pic(2)].join('\n')));
  assert.ok(mg.isMediaOnly(pic(1)));
  assert.ok(!mg.isMediaOnly('hello'));
  assert.ok(!mg.isMediaOnly(''));
  assert.ok(!mg.hasMedia('just words'));
});

test('a message carries up to ten files, fewer when the admin allows fewer', () => {
  assert.equal(mg.MAX_GROUP_MEDIA, 10);
  assert.equal(mg.groupLimit({}), 10);
  assert.equal(mg.groupLimit({ maxAttachments: '10' }), 10);
  assert.equal(mg.groupLimit({ maxAttachments: '50' }), 10, 'past ten the composer sends more messages');
  assert.equal(mg.groupLimit({ maxAttachments: '3' }), 3);
  assert.equal(mg.groupLimit({ maxAttachments: '0' }), 1);
  assert.equal(mg.groupLimit({ maxAttachments: 'junk' }), 10);
  assert.equal(mg.groupLimit({ maxAttachments: '3', forumTopic: true }), 50, 'a New Post topic keeps the ceiling');
});

test('the typed text is held to the limit, the upload lines get their own room', () => {
  const text = 'x'.repeat(2000);
  const ten = Array.from({ length: 10 }, (_, i) => pic(i)).join('\n');
  assert.ok(!mg.tooLong(`${text}\n${ten}`, 2000), 'text at the limit plus ten pictures goes');
  assert.ok(mg.tooLong(`${text}y\n${ten}`, 2000), 'text past the limit does not');
  assert.ok(mg.tooLong('x'.repeat(2001), 2000));
  assert.ok(!mg.tooLong('x'.repeat(2000), 2000));
  // An upload line cannot be used to smuggle extra text past the limit.
  const longName = `[file:${'n'.repeat(600)}.pdf](/uploads/a.pdf|1 KB)`;
  assert.ok(mg.tooLong(`${text}\n${longName}`, 2000));
  assert.ok(mg.ceiling(2000) >= 2000 + 10 * mg.MEDIA_LINE_ROOM);
});

test('refusal names the rule that was broken', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => pic(i)).join('\n');
  assert.match(mg.refusal(eleven, { maxChars: 2000 }), /^Too many attachments in one message \(max 10\)$/);
  assert.match(mg.refusal(`${'x'.repeat(201)}\n${pic(1)}`, { maxChars: 200 }), /^Message too long/);
  assert.equal(mg.refusal(`hi\n${pic(1)}\n${pic(2)}`, { maxChars: 2000 }), null);
  assert.equal(mg.refusal(eleven, { maxChars: 2000, forumTopic: true }), null);
  assert.match(mg.refusal([pic(1), pic(2), pic(3), pic(4)].join('\n'), { maxChars: 2000, maxAttachments: '3' }), /max 3/);
});

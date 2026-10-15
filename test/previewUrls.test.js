'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { absoluteHttpUrl, cleanPreviewUrls } = require('../src/previewUrls');

test('preview image URLs resolve against the page and must be http(s)', () => {
  const base = 'https://news.example/a/b/page.html';
  assert.equal(absoluteHttpUrl('/img/x.png', base), 'https://news.example/img/x.png');
  assert.equal(absoluteHttpUrl('x.png', base), 'https://news.example/a/b/x.png');
  assert.equal(absoluteHttpUrl('//cdn.example/x.png', base), 'https://cdn.example/x.png');
  assert.equal(absoluteHttpUrl('javascript:alert(1)', base), null);
  assert.equal(absoluteHttpUrl('data:image/png;base64,AAAA', base), null);
  assert.equal(absoluteHttpUrl('', base), null);

  const data = cleanPreviewUrls({
    title: 't',
    image: 'javascript:alert(1)',
    images: ['/one.png', 'data:x', 'two.png'],
    video: 'file:///etc/passwd',
    url: 'javascript:void(0)',
  }, base);
  assert.equal(data.image, null);
  assert.deepEqual(data.images, ['https://news.example/one.png', 'https://news.example/a/b/two.png']);
  assert.equal(data.video, null);
  assert.equal(data.url, base);
});

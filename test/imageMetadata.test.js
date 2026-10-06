'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const { stripJpeg, stripPng, stripWebp } = require('../src/imageMetadata');

// Fixtures are 64x32 images carrying a GPS block, a camera make ("Pixel 9")
// and, for the JPEG, orientation 6 — the shape a phone photo arrives in.
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const leaks = (buf) => buf.includes('Pixel 9') || buf.includes('GPS');

test('JPEG loses GPS and camera EXIF but keeps its orientation', () => {
  const out = stripJpeg(fixture('exif-gps.jpg'));
  assert.ok(out);
  assert.ok(!out.includes('Pixel 9'));
  // Orientation survives as a minimal big-endian IFD: tag 0x0112, SHORT, value 6
  assert.ok(out.includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06])));
  assert.deepEqual(stripJpeg(out), out);                 // stripping twice is stable
});

test('PNG loses its eXIf and text chunks', () => {
  const out = stripPng(fixture('exif-gps.png'));
  assert.ok(out);
  assert.ok(!leaks(out));
  assert.ok(!out.includes('secret location'));
  assert.ok(out.includes('IEND'));
});

test('WebP loses its EXIF chunk and the VP8X flag that announced it', () => {
  const out = stripWebp(fixture('exif-gps.webp'));
  assert.ok(out);
  assert.ok(!leaks(out));
  assert.equal(out.readUInt32LE(4), out.length - 8);
});

test('files with nothing to strip, or not images at all, are left alone', () => {
  assert.equal(stripJpeg(Buffer.from('not a jpeg')), null);
  assert.equal(stripPng(Buffer.from('<svg/>')), null);
  assert.equal(stripWebp(Buffer.from('RIFF....WAVE')), null);
});

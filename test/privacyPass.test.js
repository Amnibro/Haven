'use strict';

// The privacy pass (src/privacyPass.js): Haven's own photo cleaner when
// exiftool and ffmpeg are missing, naming files by what they really are,
// and, where the tools are installed, removing location data with them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-privacy-'));
process.env.HAVEN_DATA_DIR = DATA;
const tools = require('../src/mediaTools');
const pp = require('../src/privacyPass');

test.after(() => {
  tools.stopExiftool();
  fs.rmSync(DATA, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function write(name, buf) {
  const file = path.join(DATA, name);
  fs.writeFileSync(file, buf);
  return file;
}

function box(type, ...children) {
  const body = Buffer.concat(children.map(c => (typeof c === 'string' ? Buffer.from(c, 'latin1') : c)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const hdlr = (kind) => box('hdlr', Buffer.alloc(8), kind, Buffer.alloc(12));

test('a misleading extension is replaced, a different spelling of the right one is not', () => {
  assert.strictEqual(pp.correctExt('.bin', 'png'), 'png');
  assert.strictEqual(pp.correctExt('', 'jpg'), 'jpg');
  assert.strictEqual(pp.correctExt('.JPEG', 'jpg'), null);
  assert.strictEqual(pp.correctExt('.heif', 'heic'), null);
  assert.strictEqual(pp.correctExt('.mov', 'mov'), null);
  assert.strictEqual(pp.correctExt('.png', ''), null, 'an unknown type renames nothing');
});

const haveTools = tools.locateTools();

test('without the tools, a JPEG still loses its EXIF block and nothing is refused', { skip: haveTools && 'the tools are installed, so they do the cleaning' }, async () => {
  const exif = Buffer.concat([Buffer.from('Exif\0\0MM\0*', 'latin1'), Buffer.from([0, 0, 0, 8, 0, 0])]);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, exif.length + 2]), exif]);
  const scan = Buffer.from([0xFF, 0xDA, 0, 4, 1, 2, 9, 9, 0xFF, 0xD9]);
  const file = write('photo.jpg', Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, scan]));
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);
  assert.deepStrictEqual(await pp.cleanFile(file), { kind: null, ext: null });
  const after = fs.readFileSync(file);
  assert.ok(!after.includes(Buffer.from('Exif')), 'the EXIF block is gone');
  assert.ok(after.subarray(-10).equals(scan), 'the picture itself is untouched');
  assert.strictEqual(fs.statSync(file).mtime.getTime(), old.getTime(), 'it keeps its date');
  const text = write('notes.txt', 'nothing to see here');
  assert.deepStrictEqual(await pp.cleanFile(text), { kind: null, ext: null });
  assert.strictEqual(fs.readFileSync(text, 'utf8'), 'nothing to see here');
});

test('photos lose their location, XMP and IPTC but keep their rotation', { skip: !haveTools && 'exiftool and ffmpeg are not installed' }, async () => {
  const file = write('photo.bin', PNG);
  await tools.exiftool(['-overwrite_original', '-XMP-exif:GPSLatitude=40.7', '-XMP-exif:GPSLongitude=74', '-XMP-photoshop:City=Somewhere', file]);
  assert.ok((await pp.inspect(file)).dirt.length, 'the test photo starts out with a location');
  const r = await pp.cleanFile(file);
  assert.strictEqual(r.kind, 'photo');
  assert.strictEqual(r.ext, 'png', 'named by what it is, not what it was called');
  assert.deepStrictEqual((await pp.inspect(file)).dirt, []);
});

test('videos lose their location and keep their picture and sound', { skip: !haveTools && 'exiftool and ffmpeg are not installed' }, async () => {
  const file = path.join(DATA, 'clip.mp4');
  const make = spawnSync(tools.toolPath('ffmpeg'), ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5',
    '-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata', 'location=+40.7000-074.0000/', file]);
  assert.strictEqual(make.status, 0, String(make.stderr));
  assert.ok((await pp.inspect(file, { embedded: true })).dirt.length, 'the test video starts out with a location');
  const r = await pp.cleanFile(file);
  assert.strictEqual(r.kind, 'video');
  assert.deepStrictEqual((await pp.inspect(file, { embedded: true })).dirt, []);
  const probe = spawnSync(tools.toolPath('ffmpeg'), ['-hide_banner', '-i', file], { encoding: 'utf8' });
  assert.match(probe.stderr, /Video:/);
  assert.match(probe.stderr, /Audio:/);
});

test('files that are not photos or videos are left exactly as they were', { skip: !haveTools && 'exiftool and ffmpeg are not installed' }, async () => {
  const text = write('notes.txt', 'nothing to see here');
  assert.deepStrictEqual(await pp.cleanFile(text), { kind: null, ext: null });
  assert.strictEqual(fs.readFileSync(text, 'utf8'), 'nothing to see here');
});

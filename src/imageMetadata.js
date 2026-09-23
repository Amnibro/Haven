'use strict';

// Strip location and camera metadata from uploaded photos.
//
// Phones write GPS coordinates, device serials and timestamps into EXIF/XMP,
// and every member who can see an attachment can download the original bytes.
// We have no image library, so this walks the container format and drops the
// metadata blocks without re-encoding: pixels, ICC colour profiles and
// animation are untouched. The one EXIF field that changes how a photo looks,
// orientation, is kept by writing back a minimal EXIF block holding only it.
//
// Anything we don't recognise, or can't parse cleanly, is left exactly as it
// was — a failed strip must never break an upload.

const fs = require('fs');

// ── JPEG ─────────────────────────────────────────────────
// APP1 carries EXIF and XMP, APP13 carries IPTC/Photoshop (incl. location),
// COM is free text. APP0 (JFIF), APP2 (ICC) and APP14 (Adobe) are kept.
const JPEG_DROP = new Set([0xE1, 0xED, 0xFE]);

function exifOrientation(seg) {
  // seg = APP1 payload after the 2-byte length
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return 0;
  const t = seg.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return 0;
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return 0;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

function orientationApp1(orientation) {
  // "Exif\0\0" + big-endian TIFF header + IFD0 with a single SHORT entry
  const body = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const hdr = Buffer.from([0xFF, 0xE1, 0, 0]);
  hdr.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([hdr, body]);
}

function stripJpeg(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  const out = [buf.subarray(0, 2)];
  let orientation = 0, dropped = false, p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xFF) return null;
    const marker = buf[p + 1];
    if (marker === 0xFF) { p++; continue; }              // fill byte
    if (marker === 0xDA || marker === 0xD9) break;       // start of scan / end: copy the rest verbatim
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) return null;
    if (JPEG_DROP.has(marker)) {
      if (marker === 0xE1 && !orientation) orientation = exifOrientation(buf.subarray(p + 4, p + 2 + len));
      dropped = true;
    } else {
      out.push(buf.subarray(p, p + 2 + len));
    }
    p += 2 + len;
  }
  if (!dropped) return null;
  if (orientation > 1) {
    const afterJfif = out.length > 1 && out[1][1] === 0xE0 ? 2 : 1;   // JFIF expects APP0 first
    out.splice(afterJfif, 0, orientationApp1(orientation));
  }
  out.push(buf.subarray(p));
  return Buffer.concat(out);
}

// ── PNG ──────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out = [PNG_SIG];
  let dropped = false, p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const end = p + 12 + len;
    if (end > buf.length) return null;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (PNG_DROP.has(type)) dropped = true;
    else out.push(buf.subarray(p, end));
    p = end;
    if (type === 'IEND') break;
  }
  return dropped ? Buffer.concat(out) : null;
}

// ── WebP ─────────────────────────────────────────────────
function stripWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunks = [];
  let dropped = false, p = 12;
  while (p + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const end = p + 8 + size + (size & 1);
    if (p + 8 + size > buf.length) return null;
    if (fourcc === 'EXIF' || fourcc === 'XMP ') dropped = true;
    else chunks.push(Buffer.from(buf.subarray(p, Math.min(end, buf.length))));
    p = end;
  }
  if (!dropped) return null;
  const vp8x = chunks.find(c => c.toString('latin1', 0, 4) === 'VP8X');
  if (vp8x) vp8x[8] &= ~0x0C;                           // clear the EXIF (0x08) and XMP (0x04) flags
  const body = Buffer.concat(chunks);
  const hdr = Buffer.alloc(12);
  hdr.write('RIFF', 0, 'latin1');
  hdr.writeUInt32LE(body.length + 4, 4);
  hdr.write('WEBP', 8, 'latin1');
  return Buffer.concat([hdr, body]);
}

// Rewrite the file in place without its metadata. Returns true if it changed.
function stripImageMetadata(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const out = stripJpeg(buf) || stripPng(buf) || stripWebp(buf);
    if (!out) return false;
    const tmp = filePath + '.strip';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.warn('[uploads] metadata strip skipped:', err.message);
    return false;
  }
}

module.exports = { stripImageMetadata, stripJpeg, stripPng, stripWebp };

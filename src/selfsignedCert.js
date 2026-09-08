'use strict';

// ═══════════════════════════════════════════════════════════
// Self-signed certificate, no OpenSSL required.
//
// Haven wants HTTPS out of the box: voice, camera and the mobile app all refuse
// plain HTTP on anything but localhost. The installers used to shell out to
// OpenSSL for the certificate, and a clean Windows box has no OpenSSL, so the
// step was skipped quietly and people ended up on HTTP without knowing why
// nothing worked. This builds the certificate with Node's own crypto: an RSA
// key pair, a minimal X.509 v3 structure encoded by hand, signed with
// sha256WithRSAEncryption. Browsers treat it exactly like the OpenSSL one.
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');

// ── DER building blocks ────────────────────────────────────
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const SEQUENCE = (...parts) => der(0x30, parts);
const SET = (...parts) => der(0x31, parts);
const NULL = Buffer.from([0x05, 0x00]);

function INTEGER(buf) {
  // Positive integers whose top bit is set need a leading zero.
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}

function OID(dotted) {
  const arcs = dotted.split('.').map(Number);
  const out = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [];
    let v = arc;
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

const UTF8String = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const IA5String = (s) => der(0x16, Buffer.from(s, 'ascii'));
const OCTET_STRING = (b) => der(0x04, b);
const BIT_STRING = (b) => der(0x03, Buffer.concat([Buffer.from([0]), b]));
const EXPLICIT = (n, inner) => der(0xa0 | n, inner);

function timeValue(date) {
  const p = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const rest = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  // UTCTime only reaches 2049; anything later is GeneralizedTime.
  return y < 2050
    ? der(0x17, Buffer.from(`${String(y).slice(2)}${rest}`, 'ascii'))
    : der(0x18, Buffer.from(`${y}${rest}`, 'ascii'));
}

function name(commonName) {
  return SEQUENCE(SET(SEQUENCE(OID('2.5.4.3'), UTF8String(commonName))));
}

function ipBytes(ip) {
  const v4 = ip.split('.');
  if (v4.length === 4 && v4.every(n => /^\d{1,3}$/.test(n) && Number(n) <= 255)) {
    return Buffer.from(v4.map(Number));
  }
  return null; // IPv6 is not needed for the addresses Haven prints
}

function subjectAltName(altNames, ipAddresses) {
  const entries = [];
  for (const dns of altNames) entries.push(der(0x82, Buffer.from(dns, 'ascii')));
  for (const ip of ipAddresses) {
    const b = ipBytes(ip);
    if (b) entries.push(der(0x87, b));
  }
  return SEQUENCE(OID('2.5.29.17'), OCTET_STRING(SEQUENCE(...entries)));
}

function pem(label, derBuf) {
  const b64 = derBuf.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// ── The certificate ────────────────────────────────────────
/**
 * @param {object} [opts]
 * @param {string} [opts.commonName='Haven']
 * @param {string[]} [opts.altNames=['localhost']]   DNS names
 * @param {string[]} [opts.ipAddresses=['127.0.0.1']] IPv4 addresses
 * @param {number} [opts.days=3650]
 * @param {number} [opts.modulusLength=2048]
 * @returns {{ cert: string, key: string }} PEM strings
 */
function generateSelfSignedCert(opts = {}) {
  const commonName = opts.commonName || 'Haven';
  const altNames = Array.from(new Set(opts.altNames || ['localhost']));
  const ipAddresses = Array.from(new Set(opts.ipAddresses || ['127.0.0.1']));
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 3650;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: opts.modulusLength || 2048,
  });

  const notBefore = new Date(Date.now() - 60 * 1000); // a minute of clock slack
  const notAfter = new Date(notBefore.getTime() + days * 86400000);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // keep the serial positive

  const sigAlg = SEQUENCE(OID('1.2.840.113549.1.1.11'), NULL); // sha256WithRSAEncryption
  const tbs = SEQUENCE(
    EXPLICIT(0, INTEGER(2)),                                    // v3
    INTEGER(serial),
    sigAlg,
    name(commonName),                                           // issuer (self)
    SEQUENCE(timeValue(notBefore), timeValue(notAfter)),
    name(commonName),                                           // subject
    publicKey.export({ type: 'spki', format: 'der' }),
    EXPLICIT(3, SEQUENCE(subjectAltName(altNames, ipAddresses)))
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = SEQUENCE(tbs, sigAlg, BIT_STRING(signature));

  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

module.exports = { generateSelfSignedCert };

'use strict';

/**
 * Self-signed certificate without OpenSSL (src/selfsignedCert.js).
 * Node parses what it makes, the key matches, the names are in the SAN, and a
 * real TLS handshake succeeds against it.
 *
 *   node --test test/selfsignedCert.test.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const test = require('node:test');

const { generateSelfSignedCert } = require('../src/selfsignedCert');

const made = generateSelfSignedCert({
  commonName: 'Haven',
  altNames: ['localhost', 'haven.local'],
  ipAddresses: ['127.0.0.1', '192.168.1.20', 'not-an-ip'],
  days: 3650,
});

test('the certificate parses and describes itself', () => {
  const cert = new crypto.X509Certificate(made.cert);
  assert.equal(cert.subject, 'CN=Haven');
  assert.equal(cert.issuer, 'CN=Haven', 'self-signed');
  assert.match(cert.subjectAltName, /DNS:localhost/);
  assert.match(cert.subjectAltName, /DNS:haven\.local/);
  assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.match(cert.subjectAltName, /IP Address:192\.168\.1\.20/);
  assert.ok(!/not-an-ip/.test(cert.subjectAltName), 'junk addresses are dropped');
  const validFor = (new Date(cert.validTo) - new Date(cert.validFrom)) / 86400000;
  assert.ok(validFor > 3649 && validFor < 3651, `valid for about ten years, got ${validFor} days`);
  assert.ok(new Date(cert.validFrom) <= new Date(), 'already valid');
});

test('the private key belongs to the certificate and the signature checks out', () => {
  const cert = new crypto.X509Certificate(made.cert);
  const key = crypto.createPrivateKey(made.key);
  assert.equal(cert.checkPrivateKey(key), true);
  assert.equal(cert.verify(cert.publicKey), true, 'signed by its own key');
  assert.equal(cert.checkHost('localhost'), 'localhost');
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
});

test('a TLS server accepts the pair and a client can talk to it', async () => {
  const server = https.createServer({ cert: made.cert, key: made.key }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('secure enough');
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try {
    const body = await new Promise((resolve, reject) => {
      // No keep-alive: the pooled socket would otherwise keep the server's
      // close() waiting, and the test runner with it.
      https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false, agent: false, headers: { Connection: 'close' } }, (r) => {
        const peer = r.socket.getPeerCertificate(); // read while the socket is still ours
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve({ status: r.statusCode, text: b, cert: peer }));
      }).on('error', reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.text, 'secure enough');
    assert.equal(body.cert.subject.CN, 'Haven');
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }
});

test('every certificate is its own', () => {
  const again = generateSelfSignedCert({ days: 30 });
  const a = new crypto.X509Certificate(made.cert);
  const b = new crypto.X509Certificate(again.cert);
  assert.notEqual(a.serialNumber, b.serialNumber);
  assert.notEqual(a.fingerprint256, b.fingerprint256);
});

test('a certificate that outlives 2049 still parses', () => {
  const far = generateSelfSignedCert({ days: 365 * 30 });
  const cert = new crypto.X509Certificate(far.cert);
  assert.ok(new Date(cert.validTo).getUTCFullYear() >= 2050);
});

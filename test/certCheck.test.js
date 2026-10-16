'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { inspectCertChain, certAdvice } = require('../src/certCheck');
const { generate } = require('../src/selfsignedCert');
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-chain-'));
const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
function chain() {
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '30', '-subj', '/CN=Test Root', '-addext', 'basicConstraints=critical,CA:TRUE');
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=Test Intermediate');
  fs.writeFileSync(path.join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\n');
  ssl('x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.pem', '-days', '30', '-extfile', 'ca.ext');
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=haven.example');
  ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '30');
  return { root: read('root.pem'), int: read('int.pem'), leaf: read('leaf.pem') };
}
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('a leaf without its intermediates is reported as a missing chain, with fullchain.pem named', { skip: !hasOpenssl && 'openssl not installed' }, () => {
  const { root, int, leaf } = chain();
  assert.equal(inspectCertChain(leaf).issue, 'missing_chain');
  assert.equal(inspectCertChain(leaf + int).issue, null);
  assert.equal(inspectCertChain(int + leaf).issue, 'untrusted');
  assert.equal(inspectCertChain(leaf + int + root).issue, 'untrusted');
  fs.writeFileSync(path.join(dir, 'fullchain.pem'), leaf + int);
  const advice = certAdvice(inspectCertChain(leaf), path.join(dir, 'cert.pem'));
  assert.match(advice, /no intermediate certificates/);
  assert.ok(advice.includes(`SSL_CERT_PATH=${path.join(dir, 'fullchain.pem')}`));
  assert.equal(certAdvice(inspectCertChain(leaf + int), path.join(dir, 'fullchain.pem')), null);
});
test('Haven\'s own self-signed certificate is not a chain problem', () => {
  const { cert } = generate({ names: ['localhost'] });
  assert.equal(inspectCertChain(cert).issue, 'self_signed');
  assert.equal(certAdvice(inspectCertChain(cert), '/x/cert.pem'), null);
});
test('an expired certificate and an empty file say so', () => {
  const { cert } = generate({ names: ['localhost'], days: 1 });
  const status = inspectCertChain(cert, Date.now() + 3 * 86400000);
  assert.equal(status.issue, 'expired');
  assert.match(certAdvice(status, '/x/cert.pem'), /expired on .*certbot renew/);
  assert.equal(inspectCertChain('not a cert').issue, 'unreadable');
});

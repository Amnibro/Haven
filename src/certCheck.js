'use strict';
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { X509Certificate } = require('crypto');
let roots = null;
const storeOf = kind => { try { return tls.getCACertificates(kind); } catch { return []; } };
const rootCerts = () => roots || (roots = [...new Set([...tls.rootCertificates, ...storeOf('bundled'), ...storeOf('system')])].map(pem => { try { return new X509Certificate(pem); } catch { return null; } }).filter(Boolean));
const trusted = cert => rootCerts().some(r => r.fingerprint256 === cert.fingerprint256 || signedBy(cert, r));
const signedBy = (cert, issuer) => { try { return cert.checkIssued(issuer) && cert.verify(issuer.publicKey); } catch { return false; } };
function inspectCertChain(pem, now = Date.now()) {
  const certs = (String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map(p => new X509Certificate(p));
  if (!certs.length) return { issue: 'unreadable', certs: 0 };
  const leaf = certs[0], last = certs[certs.length - 1];
  const selfSigned = certs.length === 1 && signedBy(leaf, leaf);
  const linked = certs.every((c, i) => i === certs.length - 1 || signedBy(c, certs[i + 1]));
  const issue = Date.parse(leaf.validTo) < now ? 'expired' : selfSigned ? 'self_signed' : !linked ? 'untrusted' : certs.length === 1 ? (trusted(leaf) ? null : 'missing_chain') : signedBy(last, last) && !trusted(last) ? 'untrusted' : null;
  return { issue, certs: certs.length, subject: leaf.subject, issuer: leaf.issuer, validTo: leaf.validTo };
}
function certAdvice(status, certPath) {
  const full = path.join(path.dirname(certPath || ''), 'fullchain.pem');
  const hint = certPath && path.basename(certPath) !== 'fullchain.pem' && fs.existsSync(full) ? ` Set SSL_CERT_PATH=${full} and restart Haven.` : ' Set SSL_CERT_PATH to the full chain file (fullchain.pem from Let\'s Encrypt/certbot) and restart Haven.';
  return {
    missing_chain: `The certificate in ${certPath} has no intermediate certificates, so the chain is incomplete. Browsers may still open the page, but apps, push notifications and other servers reject it.${hint}`,
    untrusted: `The certificate chain in ${certPath} does not lead to a certificate authority this system trusts, or its certificates are out of order (leaf first, then intermediates).${hint}`,
    expired: `The certificate in ${certPath} expired on ${status.validTo}. Renew it (certbot renew) and restart Haven.`,
    unreadable: `No certificate was found in ${certPath}. It should hold PEM text starting with -----BEGIN CERTIFICATE-----.`,
  }[status.issue] || null;
}
module.exports = { inspectCertChain, certAdvice };

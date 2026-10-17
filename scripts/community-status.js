#!/usr/bin/env node
'use strict';

// Checks the community server and writes what the homepage's status line
// shows (docs/index.html, "Community server" under the join button).
//
// Run every ten minutes by .github/workflows/community-status.yml, which
// keeps the result on the site-status branch. A visitor's browser cannot
// read a certificate, so it could only tell "reachable" from "not"; this
// says why: the certificate expired, it is not valid, the server does not
// answer, or it cannot be reached at all.
//
//   node scripts/community-status.js [out.json] [previous.json]
//
// HOST overrides the server (default haven.moviethingy.xyz).

const fs = require('fs');
const https = require('https');
const tls = require('tls');

const HOST = process.env.HOST || 'haven.moviethingy.xyz';
const OUT = process.argv[2] || 'status.json';
const PREV = process.argv[3] || null;
const TIMEOUT_MS = 15000;
// A certificate this close to its end gets a warning while still working.
const SOON_MS = 3 * 24 * 60 * 60 * 1000;

// The certificate as the server presents it, valid or not.
function readCertificate() {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: HOST, port: 443, servername: HOST, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const cert = sock.getPeerCertificate();
      resolve({
        reached: true,
        authorized: sock.authorized,
        error: sock.authorizationError ? String(sock.authorizationError) : null,
        validTo: cert && cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: cert && cert.issuer ? (cert.issuer.O || cert.issuer.CN || null) : null,
      });
      sock.end();
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ reached: false, error: 'timeout' }); });
    sock.on('error', (err) => resolve({ reached: false, error: err.code || err.message }));
  });
}

// Haven's own health check, read even through a bad certificate, so an
// expired one can still say whether the server behind it is running.
function readHealth() {
  return new Promise((resolve) => {
    const req = https.get({ host: HOST, path: '/api/health', servername: HOST, rejectUnauthorized: false, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON: judged by the status code alone */ }
        resolve({ status: res.statusCode, online: !!(json && json.status === 'online'), name: json && typeof json.name === 'string' ? json.name.slice(0, 80) : null });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, online: false }); });
    req.on('error', () => resolve({ status: 0, online: false }));
  });
}

const day = (iso) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');

function judge(cert, health, now) {
  if (!cert.reached) {
    return { state: 'down', code: 'unreachable', message: "The community server can't be reached right now." };
  }
  if (!cert.authorized) {
    if (cert.error === 'CERT_HAS_EXPIRED') {
      return { state: 'down', code: 'cert-expired', message: `The community server's security certificate expired ${day(cert.validTo)}, so browsers won't connect until it's renewed.` };
    }
    return { state: 'down', code: 'cert-invalid', message: `The community server's security certificate isn't valid (${cert.error}), so browsers won't connect.` };
  }
  if (!health.online) {
    return { state: 'down', code: 'not-answering', message: "The community server isn't answering right now." };
  }
  if (cert.validTo && new Date(cert.validTo).getTime() - now < SOON_MS) {
    return { state: 'warn', code: 'cert-expiring', message: `The community server is online. Its security certificate runs out ${day(cert.validTo)}.` };
  }
  return { state: 'ok', code: 'online', message: 'The community server is online.' };
}

async function main() {
  const now = Date.now();
  const cert = await readCertificate();
  const health = cert.reached ? await readHealth() : { status: 0, online: false };
  const verdict = judge(cert, health, now);

  // "Since" carries over while the verdict stays the same. An expired
  // certificate has been down since the moment it ran out.
  let since = verdict.code === 'cert-expired' && cert.validTo ? cert.validTo : new Date(now).toISOString();
  if (PREV && verdict.code !== 'cert-expired') {
    try {
      const prev = JSON.parse(fs.readFileSync(PREV, 'utf8'));
      if (prev && prev.code === verdict.code && typeof prev.since === 'string') since = prev.since;
    } catch { /* no earlier result yet: this one starts the clock */ }
  }

  const out = {
    host: HOST,
    ...verdict,
    since,
    checkedAt: new Date(now).toISOString(),
    certificateExpires: cert.validTo || null,
    certificateIssuer: cert.issuer || null,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`${out.state}: ${out.message}`);
}

main().catch((err) => {
  console.error('[community-status]', err);
  process.exit(1);
});

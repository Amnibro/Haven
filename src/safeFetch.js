'use strict';

// ══════════════════════════════════════════════════════════════════════
// SSRF-safe fetch for URLs that came from a user (link previews, the media
// proxy). Global fetch() resolves the hostname itself, after any check we ran,
// so a check-then-fetch pair can be beaten by a DNS answer that changes in
// between (rebinding), and fetch's own redirect following never gets checked
// at all. Here every hop is resolved once, every address is judged by the same
// rules the webhook callbacks use (loopback, private, link-local, metadata,
// IPv4-mapped IPv6, NAT64 ...), and the connection is pinned to the address
// that was judged. Redirects are followed by hand so each target goes through
// the same gate.
//
// Returns a WHATWG Response so callers can keep using .ok/.status/.headers/
// .text()/.json()/.arrayBuffer() exactly as they did with fetch().
// ══════════════════════════════════════════════════════════════════════

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { resolveCallbackDestination, createPinnedLookup } = require('./webhookCallback');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Same opt-in the link previews always had for self-hosters who want previews
// of LAN services. Link-local and metadata ranges stay blocked regardless.
function _allowPrivateDefault() {
  return (process.env.ALLOW_PRIVATE_PREVIEWS || '').toLowerCase() === 'true';
}

function _decode(incoming) {
  const enc = String(incoming.headers['content-encoding'] || '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return incoming.pipe(zlib.createGunzip());
  if (enc === 'deflate') return incoming.pipe(zlib.createInflate());
  if (enc === 'br') return incoming.pipe(zlib.createBrotliDecompress());
  return incoming;
}

async function _fetchOnce(urlString, opts) {
  if (opts.signal?.aborted) throw opts.signal.reason || new Error('Aborted');
  const destination = await resolveCallbackDestination(urlString, {
    allowPrivateCallbacks: opts.allowPrivate
  });
  return new Promise((resolve, reject) => {
    const transport = destination.url.protocol === 'https:' ? https : http;
    const request = transport.request(destination.url, {
      method: 'GET',
      agent: false,
      headers: opts.headers || {},
      lookup: createPinnedLookup(destination.address, destination.family),
      signal: opts.signal
    }, incoming => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
        else if (value !== undefined) headers.set(key, String(value));
      }
      const status = incoming.statusCode;
      let body = null;
      if (NULL_BODY_STATUSES.has(status)) incoming.resume();
      else {
        const decoded = _decode(incoming);
        if (decoded !== incoming) incoming.on('error', err => decoded.destroy(err));
        body = Readable.toWeb(decoded);
      }
      try {
        resolve(new Response(body, { status, statusText: incoming.statusMessage || '', headers }));
      } catch (err) {
        incoming.destroy();
        reject(err);
      }
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * GET a user-supplied URL without letting it reach internal addresses.
 * opts: { headers, signal, redirect: 'manual' | 'follow', maxRedirects, allowPrivate }
 */
async function safeFetch(urlString, opts = {}) {
  const options = {
    ...opts,
    allowPrivate: typeof opts.allowPrivate === 'boolean' ? opts.allowPrivate : _allowPrivateDefault()
  };
  const follow = options.redirect === 'follow';
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 10;
  let current = String(urlString);
  for (let hop = 0; ; hop++) {
    const res = await _fetchOnce(current, options);
    if (!follow || !REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    try { await res.body?.cancel(); } catch { /* already closed */ }
    if (hop >= maxRedirects) throw new Error('Too many redirects');
    current = new URL(location, current).href;
  }
}

module.exports = { safeFetch };

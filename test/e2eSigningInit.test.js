'use strict';

// The signing key used to be set up twice at once on every connect, and each
// run waited for "any" published reply rather than its own. A first-time user
// could end up with one key in the backup and another pinned on the server,
// so everyone else saw their group messages as unverifiable.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const HavenGroupCrypto = require(path.join(ROOT, 'public/js/e2e-group.js'));
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/e2e.js'), 'utf8');

function loadE2E() {
  const window = {};
  const context = vm.createContext({
    window, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    HavenGroupCrypto, console, setTimeout, clearTimeout,
  });
  vm.runInContext(SOURCE, context, { filename: 'e2e.js' });
  return window.HavenE2E;
}

// One account on a stand-in server: the same rules as publish-signing-key
// and get-encrypted-key, with replies arriving after a random delay.
function makeServer() {
  const state = { signingKey: null, signingBackup: null, publishes: 0 };
  const later = (fn) => setTimeout(fn, Math.random() * 20);
  function socket() {
    const handlers = new Map();
    const deliver = (ev, data) => later(() => [...(handlers.get(ev) || [])].forEach((h) => h(data)));
    return {
      on(ev, h) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(h); },
      off(ev, h) { handlers.get(ev)?.delete(h); },
      once(ev, h) { const w = (d) => { this.off(ev, w); h(d); }; this.on(ev, w); },
      emit(ev, data) {
        later(() => {
          if (ev === 'get-encrypted-key') {
            deliver('encrypted-key-result', { signingKey: state.signingKey, signingBackup: state.signingBackup });
          } else if (ev === 'publish-signing-key') {
            const jwk = data.jwk;
            if (state.signingKey && !data.force && (state.signingKey.x !== jwk.x || state.signingKey.y !== jwk.y)) {
              return deliver('signing-key-conflict', { existing: state.signingKey, rid: data.rid });
            }
            state.publishes++;
            state.signingKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
            if (data.backup) state.signingBackup = data.backup;
            deliver('signing-key-published', { rid: data.rid });
          }
        });
      },
    };
  }
  return { state, socket };
}

async function makeClient(HavenE2E, keyPair) {
  const e2e = new HavenE2E();
  e2e._keyPair = keyPair;
  e2e._ready = true;
  return e2e;
}

const ecdh = () => webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);

test('overlapping setup calls share one run and publish one key', async () => {
  const HavenE2E = loadE2E();
  const server = makeServer();
  const keys = await ecdh();
  const e2e = await makeClient(HavenE2E, keys);
  const sock = server.socket();
  const results = await Promise.all([e2e.initSigning(sock), e2e.initSigning(sock), e2e.initSigning(sock)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(server.state.publishes, 1);
  assert.equal(server.state.signingKey.x, e2e.signingPublicJwk.x);

  // Another device on the same account opens the backup and gets the same key.
  const other = await makeClient(HavenE2E, keys);
  assert.equal(await other.initSigning(server.socket()), true);
  assert.equal(other.signingPublicJwk.x, server.state.signingKey.x);
  assert.equal(server.state.publishes, 1, 'a matching backup is used, not replaced');
});

test('two devices racing on a new account end up with the same key', async () => {
  const HavenE2E = loadE2E();
  for (let i = 0; i < 10; i++) {
    const server = makeServer();
    const keys = await ecdh();
    const a = await makeClient(HavenE2E, keys);
    const b = await makeClient(HavenE2E, keys);
    const [ra, rb] = await Promise.all([a.initSigning(server.socket()), b.initSigning(server.socket())]);
    assert.equal(ra && rb, true);
    assert.equal(a.signingPublicJwk.x, server.state.signingKey.x);
    assert.equal(b.signingPublicJwk.x, server.state.signingKey.x);
    const third = await makeClient(HavenE2E, keys);
    await third.initSigning(server.socket());
    assert.equal(third.signingPublicJwk.x, server.state.signingKey.x, 'the backup holds the pinned key');
  }
});

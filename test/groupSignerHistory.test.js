'use strict';

// A group message is shown only when it verifies under a signing key its
// author has on record. A key reset used to hide every message the author
// had sent before it, because only the current key was tried.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'public/js/e2e-group.js'));
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-groups.js'), 'utf8');

function loadGroups() {
  const context = vm.createContext({
    module: { exports: {} }, HavenGroupCrypto: G, crypto: webcrypto, console, setTimeout, clearTimeout,
    t: (key) => key, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-groups.js' });
  return context.module.exports;
}

async function signer() {
  const pair = await G.generateSigningKeyPair();
  return { pair, jwk: await G.exportPublicJwk(pair.publicKey) };
}

// An app with one group (channel 5, code g1) whose epoch 1 key it holds, and
// a server that reports `recorded` as the author's signing keys.
async function makeApp(recorded) {
  const app = Object.assign(Object.create(null), loadGroups(), {
    user: { id: 1 },
    channels: [{ id: 5, code: 'g1', is_dm: 1, is_group: 1 }],
    socket: { on() {}, off() {}, emit() {} },
    _groupFetchKeys: async () => {},
    _groupReq: async (ev, payload) => (ev === 'get-signing-key'
      ? { ev: 'signing-key-result', data: { userId: payload.userId, jwk: recorded[0], keys: recorded } }
      : null),
  });
  const epochKey = await G.generateEpochKey();
  app._groupState('g1').keys.set(1, epochKey);
  const send = async (text, pair) => JSON.stringify(await G.encryptGroupMessage(text, {
    epochKey, epoch: 1, channelId: 5, senderId: 2, prev: null, signingPrivateKey: pair.privateKey,
  }));
  return { app, send };
}

test('history signed before a key reset still verifies', async () => {
  const before = await signer();
  const after = await signer();
  const { app, send } = await makeApp([after.jwk, before.jwk]);
  const old = await app._groupDecrypt('g1', await send('from before the reset', before.pair), 2);
  assert.equal(old.ok, true);
  assert.equal(old.plaintext, 'from before the reset');
  const now = await app._groupDecrypt('g1', await send('after', after.pair), 2);
  assert.equal(now.ok, true);
});

test('a message under a key the author never published stays hidden', async () => {
  const real = await signer();
  const forged = await signer();
  const { app, send } = await makeApp([real.jwk]);
  const r = await app._groupDecrypt('g1', await send('forged', forged.pair), 2);
  assert.equal(r.ok, false);
  assert.equal(r.plaintext ?? null, null);
});

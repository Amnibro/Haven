'use strict';

// What a group member's device accepts from the server. The server relays
// every key, so these are the checks that stop it from handing out a key of
// its own: wrapped keys must come from someone's pinned encryption key, an
// epoch must be signed by a member with a signing key this device accepted,
// and the group key is never wrapped for a key that changed until the user
// trusts it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'public/js/e2e-group.js'));
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-groups.js'), 'utf8');
const subtle = webcrypto.subtle;

function loadGroups() {
  const context = vm.createContext({
    module: { exports: {} }, HavenGroupCrypto: G, crypto: webcrypto, console, setTimeout, clearTimeout,
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-groups.js' });
  return context.module.exports;
}

const pub = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });

async function identity(id) {
  const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const sign = await G.generateSigningKeyPair();
  return { id, ecdh, ecdhJwk: pub(await subtle.exportKey('jwk', ecdh.publicKey)), sign, signJwk: await G.exportPublicJwk(sign.publicKey) };
}

// The same pairwise key both ends of a 1:1 DM derive.
async function pairKey(me, theirJwk) {
  const theirs = await subtle.importKey('jwk', { ...theirJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return subtle.deriveKey({ name: 'ECDH', public: theirs }, me.ecdh.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// A stand-in server for one group (channel 5, code g1). `view` is what it
// tells clients about each user's keys, which a test can tamper with.
function makeServer(members) {
  const server = {
    view: new Map(members.map(m => [m.id, { ecdhJwk: m.ecdhJwk, signKeys: [m.signJwk] }])),
    epoch: 0, rows: [], statements: new Map(), sent: [],
  };
  server.reply = (asker, ev, payload) => {
    if (ev === 'get-signing-key') {
      const keys = server.view.get(payload.userId)?.signKeys || [];
      return { ev: 'signing-key-result', data: { userId: payload.userId, jwk: keys[0] || null, keys } };
    }
    if (ev === 'get-public-key') return { ev: 'public-key-result', data: { userId: payload.userId, jwk: server.view.get(payload.userId)?.ecdhJwk || null } };
    if (ev === 'get-group-roster') {
      return { ev: 'group-roster', data: { code: 'g1', id: 5, epoch: server.epoch, members: members.map(m => ({ id: m.id, username: `u${m.id}`, publicKey: server.view.get(m.id).ecdhJwk, signingKey: server.view.get(m.id).signKeys[0] })), pending: [] } };
    }
    if (ev === 'get-group-keys') {
      const keys = server.rows.filter(r => r.recipientId === asker && r.epoch > payload.sinceEpoch)
        .map(r => ({ epoch: r.epoch, wrappedKey: r.wrappedKey, wrappedBy: r.wrappedBy, ...server.statements.get(r.epoch) }));
      return { ev: 'group-keys', data: { code: 'g1', currentEpoch: server.epoch, keys, needsRotation: server.epoch === 0 } };
    }
    if (ev === 'publish-group-epoch') {
      server.epoch = payload.epoch;
      for (const k of payload.keys) server.rows.push({ epoch: payload.epoch, recipientId: k.recipientId, wrappedKey: k.wrappedKey, wrappedBy: asker });
      server.statements.set(payload.epoch, { publishedBy: asker, sig: payload.sig, roster: payload.roster });
      return { ev: 'group-epoch-published', data: { code: 'g1', epoch: payload.epoch } };
    }
    return null;
  };
  return server;
}

function makeApp(me, server, { pins = null } = {}) {
  const ecdhPins = new Map();
  const app = Object.assign(Object.create(null), loadGroups(), {
    user: { id: me.id },
    channels: [{ id: 5, code: 'g1', is_dm: 1, is_group: 1 }],
    toasts: [], asked: [], answer: 'cancel',
    socket: { on() {}, off() {}, emit: (ev, payload) => server.sent.push({ from: me.id, ev, payload }) },
    e2e: {
      ready: true, _publicKeyJwk: me.ecdhJwk, signingPrivateKey: me.sign.privateKey, signingPublicJwk: me.signJwk,
      pairKey: (id, jwk) => pairKey(me, jwk),
      requestPartnerKey: async (sock, id) => server.view.get(id)?.ecdhJwk || null,
      initSigning: async () => true,
    },
    _groupReq: async (ev, payload) => server.reply(me.id, ev, payload),
    _e2ePinCheck(id, jwk) {
      const fp = `${jwk.x}.${jwk.y}`;
      if (!ecdhPins.has(id)) { ecdhPins.set(id, fp); return 'new'; }
      return ecdhPins.get(id) === fp ? 'same' : 'changed';
    },
    _e2ePinSet(id, jwk) { ecdhPins.set(id, `${jwk.x}.${jwk.y}`); },
    _showToast(msg) { this.toasts.push(msg); },
    _getNickname: (id, name) => name,
    _askChoice(title) { this.asked.push(title); return Promise.resolve(this.answer); },
  });
  app.ecdhPins = ecdhPins;
  if (pins) for (const [id, jwk] of pins) ecdhPins.set(id, `${jwk.x}.${jwk.y}`);
  return app;
}

async function threeMembers() {
  const [alice, bob, carol] = await Promise.all([identity(1), identity(2), identity(3)]);
  const server = makeServer([alice, bob, carol]);
  const apps = {
    alice: makeApp(alice, server), bob: makeApp(bob, server), carol: makeApp(carol, server),
  };
  return { alice, bob, carol, server, apps };
}

test('an epoch one member publishes is accepted by the others', async () => {
  const { server, apps } = await threeMembers();
  assert.equal(await apps.alice._groupRotate('g1'), true);
  const st = await apps.bob._groupFetchKeys('g1');
  assert.ok(st.keys.has(1), 'bob opened the signed epoch');
  const env = await apps.alice._groupEncrypt('g1', 'hello');
  const r = await apps.bob._groupDecrypt('g1', env, 1);
  assert.equal(r.ok, true);
  assert.equal(r.plaintext, 'hello');
  assert.equal(server.statements.get(1).roster.length, 3);
});

test('a key wrapped under an encryption key the server swapped in is refused', async () => {
  const { alice, server, apps } = await threeMembers();
  // Bob already knows Alice's real key.
  apps.bob._e2ePinCheck(1, alice.ecdhJwk);
  // The server plants an epoch "from Alice" wrapped under its own key.
  const mallory = await identity(1);
  const planted = await G.generateEpochKey();
  server.epoch = 1;
  server.rows.push({ epoch: 1, recipientId: 2, wrappedBy: 1, wrappedKey: await G.wrapEpochKey(planted, await pairKey(mallory, apps.bob.e2e._publicKeyJwk)) });
  server.statements.set(1, { publishedBy: 1, sig: 'AAAA', roster: [] });
  server.view.get(1).ecdhJwk = mallory.ecdhJwk;
  const st = await apps.bob._groupFetchKeys('g1');
  assert.equal(st.keys.has(1), false);
  assert.ok(st.changed.has(1), 'the change is flagged for the user');
});

test('an epoch signed with a key the publisher never had, or for another group, is refused', async () => {
  const { bob, server, apps } = await threeMembers();
  await apps.alice._groupRotate('g1');
  const good = { ...server.statements.get(1) };

  // Someone in the middle re-signs Alice's epoch with a key of their own.
  const forger = await G.generateSigningKeyPair();
  server.statements.set(1, { ...good, sig: await G.signEpoch(forger.privateKey, { channelId: 5, epoch: 1, publisherId: 1, keyCommit: 'x', roster: 'y' }) });
  assert.equal((await apps.bob._groupFetchKeys('g1')).keys.has(1), false);

  // A real statement, but replayed into a group with another id.
  server.statements.set(1, good);
  apps.carol.channels[0].id = 6;
  assert.equal((await apps.carol._groupFetchKeys('g1')).keys.has(1), false);

  // No statement at all.
  server.statements.set(1, { publishedBy: 1, sig: null, roster: null });
  const bobAgain = makeApp(bob, server);
  assert.equal((await bobAgain._groupFetchKeys('g1')).keys.has(1), false);
  // And with it back, the same device opens the key.
  server.statements.set(1, good);
  assert.equal((await bobAgain._groupFetchKeys('g1')).keys.has(1), true);
});

test('a signing key added after this device pinned one is not trusted until the user says so', async () => {
  const { alice, server, apps } = await threeMembers();
  await apps.alice._groupRotate('g1');
  const before = await apps.alice._groupEncrypt('g1', 'before');
  assert.equal((await apps.bob._groupDecrypt('g1', before, 1)).ok, true, 'bob pins alice on first sight');

  // Alice "resets": the server now records a second key for her.
  const fresh = await G.generateSigningKeyPair();
  server.view.get(1).signKeys = [await G.exportPublicJwk(fresh.publicKey), alice.signJwk];
  apps.bob._signerKeys.delete(1);
  apps.alice.e2e.signingPrivateKey = fresh.privateKey;
  apps.alice.e2e.signingPublicJwk = server.view.get(1).signKeys[0];
  const after = await apps.alice._groupEncrypt('g1', 'after');
  const hidden = await apps.bob._groupDecrypt('g1', after, 1);
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason, 'signer-changed');
  assert.equal((await apps.bob._groupDecrypt('g1', before, 1)).ok, true, 'history under the accepted key still shows');

  apps.bob.answer = 'trust';
  assert.equal(await apps.bob._groupReviewKeys('g1'), true);
  const shown = await apps.bob._groupDecrypt('g1', after, 1);
  assert.equal(shown.ok, true);
  assert.equal(shown.plaintext, 'after');
});

test('a rewrap request for a changed key waits for the user, and a pinned one is answered', async () => {
  const { carol, server, apps } = await threeMembers();
  await apps.alice._groupRotate('g1');
  apps.alice._e2ePinCheck(3, carol.ecdhJwk);
  // The server forges a request "from Carol" and answers with its own key.
  const mallory = await identity(3);
  server.view.get(3).ecdhJwk = mallory.ecdhJwk;
  server.sent.length = 0;
  await apps.alice._groupRewrap({ code: 'g1', userId: 3, epoch: 1 });
  assert.equal(server.sent.filter(m => m.ev === 'rewrap-group-key').length, 0, 'nothing was wrapped for the swapped key');
  assert.ok(apps.alice._groupState('g1').pendingRewraps.has(3));

  // With the real key back, the same request is answered.
  server.view.get(3).ecdhJwk = carol.ecdhJwk;
  await apps.alice._groupRewrap({ code: 'g1', userId: 3, epoch: 1 });
  assert.equal(server.sent.filter(m => m.ev === 'rewrap-group-key').length, 1);
});

test('rotation refuses to wrap for a member whose key changed', async () => {
  const { bob, server, apps } = await threeMembers();
  apps.alice._e2ePinCheck(2, bob.ecdhJwk);
  server.view.get(2).ecdhJwk = (await identity(2)).ecdhJwk;
  assert.equal(await apps.alice._groupRotate('g1'), false);
  assert.equal(server.epoch, 0, 'nothing was published');
  assert.ok(apps.alice._groupState('g1').changed.has(2));
});

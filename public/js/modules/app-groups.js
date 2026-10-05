export default {
_setupGroupListeners() {
  this._groups = new Map();
  if (!this._groupButtonBound) {
    this._groupButtonBound = true;
    document.getElementById('new-group-dm-btn')?.addEventListener('click', (e) => { e.stopPropagation(); this._openGroupPicker(); });
  }
  const s = this.socket;
  s.on('group-dm-invite', (d) => this._showGroupInvite(d));
  s.on('group-dm-invites', (d) => (d.invites || []).forEach(i => this._showGroupInvite(i)));
  s.on('group-dm-opened', async (d) => {
    this._groups.delete(d.code);
    s.emit('get-channels');
    await new Promise(r => setTimeout(r, 400));
    this._groupEnsure(d.code).catch(() => {});
    if (this._pendingGroupOpen === d.code || this._pendingGroupOpen === true) {
      if (d.existing) this._showToast(t('groups.already_exists', { name: d.name || t('groups.default_name') }), 'info');
      this._pendingGroupOpen = null;
      this.switchChannel(d.code);
    }
  });
  s.on('group-dm-member-joined', (d) => this._groupMembershipChanged(d.code));
  s.on('group-dm-member-left', (d) => this._groupMembershipChanged(d.code));
  s.on('group-dm-updated', () => s.emit('get-channels'));
  s.on('group-dm-left', (d) => {
    this._groups.delete(d.code);
    if (this._leavingGroup === d.code) { this._leavingGroup = null; this._showToast(t('groups.left'), 'info'); }
  });
  s.on('group-epoch-published', (d) => { const st = this._groups.get(d.code); if (st && !st.keys.has(d.epoch)) this._groupFetchKeys(d.code).catch(() => {}); });
  s.on('group-rewrap-requested', (d) => this._groupRewrap(d).catch(() => {}));
  s.on('group-rewrap-fulfilled', (d) => this._groups.get(d.code)?.pendingRewraps.delete(d.userId));
  s.on('group-key-rewrapped', (d) => {
    const st = this._groups.get(d.code);
    if (!st) return;
    st.rewrapAsked = false;
    this._groupFetchKeys(d.code).then(() => this._groupRerender(d.code), err => console.warn('[Groups] could not load the re-shared key:', err.message));
  });
  s.on('connect', () => s.emit('get-group-invites'));
  if (s.connected) s.emit('get-group-invites');
},
_isGroupDm(code) {
  const ch = this.channels?.find(c => c.code === code);
  return !!(ch && ch.is_dm && ch.is_group);
},
_isGroupEnvelope(content) {
  if (typeof content !== 'string' || content.charCodeAt(0) !== 123) return false;
  try { const o = JSON.parse(content); return !!(o && o.v === 3 && o.sig && o.iv && o.ct); } catch { return false; }
},
_groupState(code) {
  if (!this._groups) this._groups = new Map();
  if (!this._groups.has(code)) this._groups.set(code, { keys: new Map(), epoch: 0, roster: null, needsRotation: false, lastHash: null, lastId: 0, busy: null, changed: new Set(), pendingRewraps: new Map(), reviewing: null });
  return this._groups.get(code);
},
_groupReq(emitEvent, payload, results, ms = 8000) {
  return new Promise(resolve => {
    const s = this.socket;
    const handlers = Object.entries(results).map(([ev, match]) => [ev, (d) => { if (match && !match(d)) return; done({ ev, data: d }); }]);
    const done = (r) => { clearTimeout(timer); handlers.forEach(([ev, h]) => s.off(ev, h)); resolve(r); };
    const timer = setTimeout(() => done(null), ms);
    handlers.forEach(([ev, h]) => s.on(ev, h));
    s.emit(emitEvent, payload);
  });
},
async _groupRoster(code) {
  const r = await this._groupReq('get-group-roster', { code }, { 'group-roster': d => d.code === code });
  if (!r) return null;
  const st = this._groupState(code);
  st.roster = r.data;
  // A current key we have not seen means the list we hold is out of date.
  for (const m of r.data.members) {
    const known = this._signerKeys?.get(m.id);
    if (known && m.signingKey && !known.some(k => k.x === m.signingKey.x && k.y === m.signingKey.y)) this._signerKeys.delete(m.id);
  }
  return r.data;
},
async _groupPublicKey(userId, roster) {
  if (userId === this.user?.id) return this.e2e._publicKeyJwk;
  const m = roster?.members?.find(x => x.id === userId);
  return m?.publicKey || this._dmPublicKeys?.[userId] || await this.e2e.requestPartnerKey(this.socket, userId);
},
async _groupFetchKeys(code, { all = false } = {}) {
  const st = this._groupState(code);
  const since = st.keys.size && !all ? Math.max(...st.keys.keys()) : 0;
  const r = await this._groupReq('get-group-keys', { code, sinceEpoch: since }, { 'group-keys': d => d.code === code });
  if (!r) return st;
  st.epoch = r.data.currentEpoch;
  st.needsRotation = !!r.data.needsRotation;
  const roster = st.roster || await this._groupRoster(code);
  for (const k of r.data.keys) {
    if (st.keys.has(k.epoch)) continue;
    try {
      const key = await this._groupOpenEpochKey(code, k, roster);
      if (key) st.keys.set(k.epoch, key);
    } catch (err) {
      // Usually sealed to a key the wrapper has since replaced.
      console.warn(`[Groups] could not open the key for epoch ${k.epoch}:`, err.message);
    }
  }
  if (st.epoch && !st.keys.has(st.epoch) && !st.needsRotation && !st.rewrapAsked) {
    st.rewrapAsked = true;
    this.socket.emit('request-group-rewrap', { code });
  }
  return st;
},
/**
 * Open one wrapped epoch key, and accept it only when both hold:
 *   1. whoever wrapped it has the encryption key this device pinned for them,
 *      so the server cannot wrap a key of its own under a key it swapped in;
 *   2. the member who published the epoch signed it, for this group, this
 *      epoch and a member list that includes us, with a signing key this
 *      device has accepted for them.
 */
async _groupOpenEpochKey(code, k, roster) {
  const me = this.user.id;
  const wrapperJwk = await this._groupPublicKey(k.wrappedBy, roster);
  if (!wrapperJwk) return null;
  if (k.wrappedBy !== me && this._e2ePinCheck(k.wrappedBy, wrapperJwk) === 'changed') {
    this._groupNoteChange(code, k.wrappedBy);
    return null;
  }
  const epochKey = await HavenGroupCrypto.unwrapEpochKey(k.wrappedKey, await this.e2e.pairKey(k.wrappedBy, wrapperJwk));
  const roll = Array.isArray(k.roster) ? k.roster : [];
  if (!k.sig || !roll.some(m => m.id === me) || !roll.some(m => m.id === k.publishedBy)) {
    console.warn(`[Groups] refused the key for epoch ${k.epoch}: it has no signed statement that includes us`);
    return null;
  }
  const fields = {
    channelId: this._groupChannelId(code), epoch: k.epoch, publisherId: k.publishedBy,
    keyCommit: await HavenGroupCrypto.epochKeyCommit(epochKey),
    roster: await HavenGroupCrypto.rosterDigest(roll),
  };
  const verdict = await this._groupVerifyBy(k.publishedBy, jwk => HavenGroupCrypto.verifyEpoch(jwk, k.sig, fields));
  if (verdict === 'ok') return epochKey;
  if (verdict === 'changed') this._groupNoteChange(code, k.publishedBy);
  else console.warn(`[Groups] refused the key for epoch ${k.epoch}: its signature did not verify`);
  return null;
},
_groupChannelId(code) {
  return this.channels?.find(c => c.code === code)?.id ?? this._groups?.get(code)?.roster?.id;
},
_groupEnsure(code) {
  const st = this._groupState(code);
  if (st.busy) return st.busy;
  st.busy = (async () => {
    if (!this.e2e?.ready) throw new Error('E2E not ready');
    if (!this.e2e.signingPrivateKey) await this.e2e.initSigning(this.socket);
    await this._groupRoster(code);
    await this._groupFetchKeys(code);
    if (st.needsRotation || !st.epoch) await this._groupRotate(code);
    return st;
  })().finally(() => { st.busy = null; });
  return st.busy;
},
async _groupRotate(code, attempt = 0) {
  if (!this.e2e?.ready) return false;
  const st = this._groupState(code);
  const roster = await this._groupRoster(code);
  if (!roster || !roster.members.some(m => m.id === this.user.id)) return false;
  if (!this.e2e.signingPrivateKey && !(await this.e2e.initSigning(this.socket))) return false;
  const pick = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
  const epochKey = await HavenGroupCrypto.generateEpochKey();
  const keys = [];
  const snapshot = [];
  for (const m of roster.members) {
    const mine = m.id === this.user.id;
    const jwk = await this._groupPublicKey(m.id, roster);
    const signJwk = mine ? this.e2e.signingPublicJwk : m.signingKey;
    if (!jwk || !signJwk) return false;
    // Never wrap the group key for a key this device has not accepted.
    if (!mine && this._e2ePinCheck(m.id, jwk) === 'changed') {
      this._groupNoteChange(code, m.id);
      return false;
    }
    keys.push({ recipientId: m.id, wrappedKey: await HavenGroupCrypto.wrapEpochKey(epochKey, await this.e2e.pairKey(m.id, jwk)) });
    snapshot.push({ id: m.id, ecdhJwk: pick(jwk), signJwk: pick(signJwk) });
  }
  const epoch = roster.epoch + 1;
  const sig = await HavenGroupCrypto.signEpoch(this.e2e.signingPrivateKey, {
    channelId: this._groupChannelId(code), epoch, publisherId: this.user.id,
    keyCommit: await HavenGroupCrypto.epochKeyCommit(epochKey),
    roster: await HavenGroupCrypto.rosterDigest(snapshot),
  });
  const r = await this._groupReq('publish-group-epoch', { code, epoch, keys, sig, roster: snapshot }, {
    'group-epoch-published': d => d.code === code && d.epoch === epoch,
    'group-epoch-conflict': d => d.code === code,
    'error-msg': null,
  });
  if (r?.ev === 'group-epoch-published') {
    st.keys.set(epoch, epochKey);
    st.epoch = epoch;
    st.needsRotation = false;
    return true;
  }
  await this._groupFetchKeys(code);
  if (st.needsRotation && attempt < 2) {
    await new Promise(res => setTimeout(res, 300 + Math.random() * 900));
    return this._groupRotate(code, attempt + 1);
  }
  return st.keys.has(st.epoch);
},
async _groupMembershipChanged(code) {
  const st = this._groupState(code);
  st.roster = null;
  this.socket.emit('get-channels');
  await new Promise(r => setTimeout(r, Math.random() * 1500));
  await this._groupFetchKeys(code);
  if (st.needsRotation) await this._groupRotate(code);
},
async _groupRewrap(d) {
  if (!d || d.userId === this.user?.id) return;
  const st = this._groupState(d.code);
  if (!st.keys.has(d.epoch)) await this._groupFetchKeys(d.code);
  const key = st.keys.get(d.epoch);
  if (!key) return;
  const r = await this._groupReq('get-public-key', { userId: d.userId }, { 'public-key-result': x => x.userId === d.userId });
  const jwk = r?.data?.jwk;
  if (!jwk) return;
  // The request reaches us through the server, which could forge one and
  // answer with a key of its own. The group key only goes to the key this
  // device has pinned for that person; a changed one waits for the user.
  if (this._e2ePinCheck(d.userId, jwk) === 'changed') {
    st.pendingRewraps.set(d.userId, d);
    this._groupNoteChange(d.code, d.userId);
    return;
  }
  const wrappedKey = await HavenGroupCrypto.wrapEpochKey(key, await this.e2e.pairKey(d.userId, jwk));
  this.socket.emit('rewrap-group-key', { code: d.code, recipientId: d.userId, epoch: d.epoch, wrappedKey, recipientPublicKey: JSON.stringify(jwk) });
},
async _groupEncrypt(code, text) {
  const st = await this._groupEnsure(code);
  const key = st.keys.get(st.epoch);
  const ch = this.channels.find(c => c.code === code);
  if (!key || !ch || !this.e2e.signingPrivateKey) throw new Error('Group encryption not ready');
  const env = JSON.stringify(await HavenGroupCrypto.encryptGroupMessage(text, { epochKey: key, epoch: st.epoch, channelId: ch.id, senderId: this.user.id, prev: st.lastHash, signingPrivateKey: this.e2e.signingPrivateKey }));
  st.lastHash = await HavenGroupCrypto.envelopeHash(env);
  return env;
},
/**
 * Every signing key the server has on record for a user, current one first.
 * A key reset replaces the current key but the old ones stay on record, so
 * messages signed before the reset still verify.
 */
async _groupSignerKeys(userId) {
  if (!this._signerKeys) this._signerKeys = new Map();
  if (this._signerKeys.has(userId)) return this._signerKeys.get(userId);
  const r = await this._groupReq('get-signing-key', { userId }, { 'signing-key-result': d => d.userId === userId });
  if (!r) return [];
  const all = [r.data.jwk, ...(r.data.keys || [])].filter(k => k && k.x && k.y);
  const keys = all.filter((k, i) => all.findIndex(o => o.x === k.x && o.y === k.y) === i);
  this._signerKeys.set(userId, keys);
  return keys;
},
/**
 * Run `check(jwk)` over a user's recorded signing keys. 'ok' when a key this
 * device has accepted for them passes; 'changed' when only a key it has not
 * accepted yet passes (they reset their keys, or someone is posing as them);
 * 'bad' when none does.
 */
async _groupVerifyBy(userId, check) {
  const run = async () => {
    const { accepted, unaccepted } = this._groupPartitionSigners(userId, await this._groupSignerKeys(userId));
    for (const jwk of accepted) if (await check(jwk)) return 'ok';
    for (const jwk of unaccepted) if (await check(jwk)) return 'changed';
    return 'bad';
  };
  let verdict = await run();
  // They may have changed keys since we last asked. Ask again, but not for
  // every message in a page of history.
  const asked = this._signerAskedAt?.get(userId) || 0;
  if (verdict === 'bad' && Date.now() - asked > 30000) {
    if (!this._signerAskedAt) this._signerAskedAt = new Map();
    this._signerAskedAt.set(userId, Date.now());
    this._signerKeys?.delete(userId);
    verdict = await run();
  }
  return verdict;
},
// Signing keys this device has accepted, per user, kept like the encryption
// key pins (_e2ePins). The first keys seen for someone are accepted as they
// are; a key added later waits until the user trusts it.
_sigPinStore() {
  return `haven_e2e_signpins_${this.user?.id}`;
},
_sigPins() {
  const store = this._sigPinStore();
  if (this._sigPinCache?.store === store) return this._sigPinCache.pins;
  let pins = {};
  try { pins = JSON.parse(localStorage.getItem(store) || '{}') || {}; } catch (err) { console.warn('[Groups] saved signing key pins unreadable, starting over:', err.message); }
  this._sigPinCache = { store, pins };
  return pins;
},
_sigPinAdd(userId, keys) {
  const pins = this._sigPins();
  pins[userId] = [...new Set([...(pins[userId] || []), ...keys.map(k => `${k.x}.${k.y}`)])];
  try { localStorage.setItem(this._sigPinStore(), JSON.stringify(pins)); } catch { /* no storage: the pins last for this session only */ }
},
_groupPartitionSigners(userId, keys) {
  const pinned = this._sigPins()[userId];
  if (!pinned || !pinned.length) {
    if (keys.length) this._sigPinAdd(userId, keys);
    return { accepted: keys, unaccepted: [] };
  }
  const ok = new Set(pinned);
  const own = userId === this.user?.id && this.e2e?.signingPublicJwk;
  if (own) ok.add(`${own.x}.${own.y}`);
  return { accepted: keys.filter(k => ok.has(`${k.x}.${k.y}`)), unaccepted: keys.filter(k => !ok.has(`${k.x}.${k.y}`)) };
},
async _groupDecrypt(code, content, senderId, msgId = 0) {
  const st = this._groupState(code);
  let env;
  try { env = JSON.parse(content); } catch { return { ok: false, reason: 'malformed' }; }
  if (!st.keys.has(env.e)) await this._groupFetchKeys(code);
  const key = st.keys.get(env.e);
  if (!key) return { ok: false, reason: 'no-key' };
  const channelId = this._groupChannelId(code);
  let opened = null;
  // Fail closed: a message that verifies under none of its author's
  // accepted keys stays hidden.
  const verdict = await this._groupVerifyBy(senderId, async (jwk) => {
    const res = await HavenGroupCrypto.decryptGroupMessage(env, { epochKey: key, channelId, senderId, signingPublicJwk: jwk });
    if (res.ok || res.reason === 'wrong-epoch-key') { opened = res; return true; }
    return false;
  });
  let r = { ok: false, plaintext: null, reason: 'bad-signature' };
  if (verdict === 'ok') r = opened;
  else if (verdict === 'changed') { r = { ok: false, plaintext: null, reason: 'signer-changed' }; this._groupNoteChange(code, senderId); }
  if (r.ok && msgId >= st.lastId) { st.lastId = msgId; st.lastHash = await HavenGroupCrypto.envelopeHash(content); }
  return r;
},
async _decryptGroupMessages(messages, ch) {
  const fail = (r, id) => (r.reason === 'no-key' ? t('groups.no_key')
    : r.reason === 'signer-changed' ? t('groups.signer_changed', { name: this._groupMemberName(ch.code, id) })
    : t('groups.cannot_verify'));
  for (const msg of messages) {
    if (this._isGroupEnvelope(msg.content)) {
      const r = await this._groupDecrypt(ch.code, msg.content, msg.user_id, msg.id || 0);
      msg.content = r.ok ? r.plaintext : fail(r, msg.user_id);
      msg._e2e = r.ok;
      msg._e2eVerified = r.ok;
    } else if (msg.user_id && typeof msg.content === 'string' && msg.content) {
      msg.content = t('groups.cannot_verify');
      msg._e2e = false;
      msg._e2eVerified = false;
    }
    this._rememberDmAttachments?.(msg);
    if (msg.replyContext && this._isGroupEnvelope(msg.replyContext.content)) {
      const r = await this._groupDecrypt(ch.code, msg.replyContext.content, msg.replyContext.user_id);
      msg.replyContext.content = r.ok ? r.plaintext : fail(r, msg.replyContext.user_id);
    }
  }
},
async _groupEncryptBytes(code, buf) {
  const st = await this._groupEnsure(code);
  const key = st.keys.get(st.epoch);
  if (!key) throw new Error('Group encryption not ready');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf));
  const out = new Uint8Array(17 + ct.length);
  out[0] = 0x47;
  new DataView(out.buffer).setUint32(1, st.epoch);
  out.set(iv, 5);
  out.set(ct, 17);
  return out;
},
async _groupDecryptBytes(code, data) {
  if (data[0] !== 0x47) throw new Error('Not a group attachment');
  const epoch = new DataView(data.buffer, data.byteOffset).getUint32(1);
  const st = this._groupState(code);
  if (!st.keys.has(epoch)) await this._groupFetchKeys(code);
  const key = st.keys.get(epoch);
  if (!key) throw new Error('No key for this attachment');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(5, 17) }, key, data.slice(17));
},
_groupMemberName(code, userId) {
  const m = this._groups?.get(code)?.roster?.members?.find(x => x.id === userId)
    || this.channels?.find(c => c.code === code)?.group_members?.find(x => x.id === userId);
  return this._getNickname(userId, m?.username || t('groups.someone'));
},
/** Someone's keys no longer match what this device accepted for them. */
_groupNoteChange(code, userId) {
  const st = this._groupState(code);
  if (st.changed.has(userId)) return;
  st.changed.add(userId);
  this._showToast(t('groups.key_changed', { name: this._groupMemberName(code, userId) }), 'warning');
  if (this.currentChannel === code || this._activeDMPip === code) {
    this._groupReviewKeys(code).catch(err => console.warn('[Groups] key review failed:', err.message));
  }
},
/**
 * Ask whether to trust the new keys of everyone whose keys changed, the way a
 * 1:1 DM asks before sending to a changed key. Until then the group key is
 * not shared with their new key and messages signed with it stay hidden.
 */
_groupReviewKeys(code) {
  const st = this._groupState(code);
  if (!st.changed.size) return Promise.resolve(true);
  if (st.reviewing) return st.reviewing;
  st.reviewing = (async () => {
    const ids = [...st.changed];
    const names = ids.map(id => this._groupMemberName(code, id)).join(', ');
    const choice = await this._askChoice(t('groups.keys_changed_title'), t('groups.keys_changed_body', { names }), [
      { id: 'cancel', label: t('modals.common.cancel') },
      { id: 'trust', label: t('groups.trust_keys'), danger: true },
    ]);
    if (choice !== 'trust') return false;
    for (const id of ids) {
      await this._groupTrustKeys(id);
      st.changed.delete(id);
    }
    for (const d of [...st.pendingRewraps.values()]) {
      st.pendingRewraps.delete(d.userId);
      await this._groupRewrap(d);
    }
    await this._groupFetchKeys(code, { all: true });
    if (st.needsRotation) await this._groupRotate(code);
    this._groupRerender(code);
    return true;
  })().finally(() => { st.reviewing = null; });
  return st.reviewing;
},
/** Accept a person's current encryption key and every signing key on record. */
async _groupTrustKeys(userId) {
  const jwk = await this.e2e.requestPartnerKey(this.socket, userId);
  if (jwk) this._e2ePinSet(userId, jwk);
  this._signerKeys?.delete(userId);
  const keys = await this._groupSignerKeys(userId);
  if (keys.length) this._sigPinAdd(userId, keys);
},
/** The group version of the DM send gate: { partner }, or null when not sent. */
async _groupSendGate(code) {
  const failed = (err) => {
    console.warn('[Groups] encryption not ready:', err.message);
    this._showToast(t('toasts.encryption_failed_not_sent'), 'error');
    return null;
  };
  try { await this._groupEnsure(code); } catch (err) { return failed(err); }
  if (this._groupState(code).changed.size) {
    if (!(await this._groupReviewKeys(code))) return null;
    try { await this._groupEnsure(code); } catch (err) { return failed(err); }
  }
  return { partner: this._getE2EPartnerFor(code) };
},
/** Load the group's messages again, wherever it is open. */
_groupRerender(code) {
  if (this.currentChannel === code) {
    this._oldestMsgId = null;
    this._noMoreHistory = false;
    this._loadingHistory = false;
    this._historyBefore = null;
    this._newestMsgId = null;
    this._noMoreFuture = true;
    this._loadingFuture = false;
    this._historyAfter = null;
    this.socket.emit('get-messages', { code });
  }
  if (this._activeDMPip === code) this._openDMPiP?.(code);
},
_e2eEncryptText(partner, text) {
  return partner.group ? this._groupEncrypt(partner.code, text) : this.e2e.encrypt(text, partner.userId, partner.publicKeyJwk);
},
async _e2eDecryptText(partner, content, senderId) {
  if (!partner.group) return this.e2e.decrypt(content, partner.userId, partner.publicKeyJwk);
  const r = await this._groupDecrypt(partner.code, content, senderId);
  return r.ok ? r.plaintext : null;
},
_e2eEncryptBytes(partner, buf) {
  return partner.group ? this._groupEncryptBytes(partner.code, buf) : this.e2e.encryptBytes(buf, partner.userId, partner.publicKeyJwk);
},
_e2eDecryptBytes(partner, data) {
  return partner.group ? this._groupDecryptBytes(partner.code, data) : this.e2e.decryptBytes(data, partner.userId, partner.publicKeyJwk);
},
_groupName(ch) {
  const names = (ch.group_members || []).filter(m => m.id !== this.user?.id).map(m => this._getNickname(m.id, m.username));
  return ch.name && ch.name !== 'Group DM' ? ch.name : (names.join(', ') || t('groups.default_name'));
},
async _groupCandidates() {
  const seen = new Map();
  const add = (id, name, bot) => { if (id && id !== this.user?.id && !bot) seen.set(id, name); };
  const home = this.channels?.find(c => c.code === this.currentChannel && !c.is_dm) || this.channels?.find(c => !c.is_dm);
  const res = await new Promise(r => { const tm = setTimeout(() => r(null), 4000); this.socket.emit('get-all-members', home ? { channelCode: home.code } : {}, (d) => { clearTimeout(tm); r(d); }); });
  for (const u of (res?.members || [])) add(u.id, u.displayName || u.username, u.isBot || u.is_bot);
  for (const list of (this._onlineByChannel?.values() || [])) for (const u of list) add(u?.id, u?.displayName || u?.username, u?.isBot);
  for (const ch of (this.channels || [])) if (ch.is_dm && !ch.is_group && ch.dm_target) add(ch.dm_target.id, ch.dm_target.username);
  return [...seen.entries()].map(([id, username]) => ({ id, username: this._getNickname(id, username) })).sort((a, b) => a.username.localeCompare(b.username));
},
async _openGroupPicker({ code = null } = {}) {
  document.getElementById('group-picker-modal')?.remove();
  const ch = code && this.channels.find(c => c.code === code);
  const exclude = new Set([...(ch?.group_members || []), ...(ch?.group_pending || [])].map(m => m.id));
  const people = (await this._groupCandidates()).filter(p => !exclude.has(p.id));
  const modal = document.createElement('div');
  modal.id = 'group-picker-modal';
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';
  modal.innerHTML = '<div class="modal group-picker"><h3 class="gp-title"></h3><input class="gp-name settings-text-input" maxlength="50"><input class="gp-search settings-text-input" type="search"><div class="gp-list"></div><p class="gp-hint"></p><div class="modal-actions"><button class="btn-sm gp-cancel"></button><button class="btn-sm btn-accent gp-go" disabled></button></div></div>';
  const q = (sel) => modal.querySelector(sel);
  q('.gp-title').textContent = t(code ? 'groups.add_people' : 'groups.new_group');
  q('.gp-name').placeholder = t('groups.name_placeholder');
  q('.gp-name').style.display = code ? 'none' : '';
  q('.gp-search').placeholder = t('groups.search_people');
  q('.gp-hint').textContent = t('groups.e2e_hint');
  q('.gp-cancel').textContent = t('modals.common.cancel');
  q('.gp-go').textContent = t(code ? 'groups.invite' : 'groups.create');
  const picked = new Set();
  const need = code ? 1 : 2;
  const render = () => {
    const f = q('.gp-search').value.trim().toLowerCase();
    const list = q('.gp-list');
    list.replaceChildren();
    people.filter(p => !f || p.username.toLowerCase().includes(f)).forEach(p => {
      const row = document.createElement('label');
      row.className = 'gp-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = picked.has(p.id);
      box.addEventListener('change', () => { box.checked ? picked.add(p.id) : picked.delete(p.id); q('.gp-go').disabled = picked.size < need || picked.size > 49; });
      const name = document.createElement('span');
      name.textContent = p.username;
      row.append(box, name);
      list.appendChild(row);
    });
    if (!list.children.length) { const e = document.createElement('p'); e.className = 'gp-empty'; e.textContent = t('groups.nobody'); list.appendChild(e); }
  };
  q('.gp-search').addEventListener('input', render);
  q('.gp-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  q('.gp-go').addEventListener('click', () => {
    const userIds = [...picked];
    if (code) this.socket.emit('invite-group-dm', { code, userIds });
    else { this._pendingGroupOpen = true; this.socket.emit('start-group-dm', { userIds, name: q('.gp-name').value.trim() }); }
    modal.remove();
  });
  render();
  document.body.appendChild(modal);
  q(code ? '.gp-search' : '.gp-name').focus();
},
_showGroupInvite(d) {
  if (!d?.code || document.querySelector(`.group-invite[data-code="${d.code}"]`)) return;
  let stack = document.getElementById('group-invite-stack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'group-invite-stack'; document.body.appendChild(stack); }
  const card = document.createElement('div');
  card.className = 'group-invite';
  card.dataset.code = d.code;
  card.innerHTML = '<div class="gi-text"><div class="gi-title"></div><div class="gi-sub"></div></div><button class="btn-sm btn-accent gi-accept"></button><button class="btn-sm gi-decline"></button>';
  const members = [...(d.members || []), ...(d.pending || [])].filter(m => m.id !== this.user?.id).map(m => this._getNickname(m.id, m.username));
  card.querySelector('.gi-title').textContent = t('groups.invited', { name: this._getNickname(d.invitedBy?.id, d.invitedBy?.username), group: d.name && d.name !== 'Group DM' ? d.name : t('groups.default_name') });
  card.querySelector('.gi-sub').textContent = members.join(', ');
  card.querySelector('.gi-accept').textContent = t('groups.accept');
  card.querySelector('.gi-decline').textContent = t('groups.decline');
  card.querySelector('.gi-accept').addEventListener('click', () => { this._pendingGroupOpen = d.code; this.socket.emit('accept-group-dm', { code: d.code }); card.remove(); });
  card.querySelector('.gi-decline').addEventListener('click', () => { this.socket.emit('decline-group-dm', { code: d.code }); card.remove(); });
  stack.appendChild(card);
},
async _collectDmAttachments(code) {
  // Gather all attachment URLs from the (decrypted) cached messages
  // for this DM so the server can move E2E ciphertext-hidden uploads
  // to deleted-attachments. (#5299)
  const attachments = [];
  const _scanMsgsForAttachments = (msgs) => {
    const re = /\/uploads\/((?!deleted-attachments)[\w\-.]+)/g;
    for (const msg of msgs) {
      if (!msg || typeof msg.content !== 'string') continue;
      let m;
      while ((m = re.exec(msg.content)) !== null) attachments.push('/uploads/' + m[1]);
    }
  };
  // Paginate through ALL messages in the DM so we don't miss E2E
  // attachment URLs in older messages that haven't been rendered yet. (#5299)
  try {
    const channel = this.channels?.find(c => c.code === code);
    if (channel?.is_dm && channel.dm_target) {
      await this._fetchDMPartnerKey(channel);
    }
    const PAGE_LIMIT = 100;
    let before = null;
    for (;;) {
      const page = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.socket.off('message-history', onHistory);
          resolve([]);
        }, 5000);
        const onHistory = (data) => {
          if (!data || data.channelCode !== code) return;
          this.socket.off('message-history', onHistory);
          clearTimeout(timer);
          resolve(Array.isArray(data.messages) ? data.messages : []);
        };
        this.socket.on('message-history', onHistory);
        this.socket.emit('get-messages', { code, before, limit: PAGE_LIMIT });
      });
      if (page.length === 0) break;
      try { await this._decryptMessages(page, code); } catch {}
      _scanMsgsForAttachments(page);
      if (page.length < PAGE_LIMIT) break;
      // Messages arrive in DESC order; last item is the oldest — use it as cursor.
      before = page[page.length - 1].id;
    }
  } catch { /* best-effort — server still cleans up plaintext messages */ }
  return attachments;
},
_leaveGroup(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch || !confirm(t('groups.leave_confirm', { group: this._groupName(ch) }))) return;
  this._leavingGroup = code;
  const last = (ch.group_members || []).every(m => m.id === this.user?.id);
  (last ? this._collectDmAttachments(code) : Promise.resolve([])).then(attachments => this.socket.emit('leave-group-dm', { code, attachments }));
},
};

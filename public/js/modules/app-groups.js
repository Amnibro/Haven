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
  if (!this._groups.has(code)) this._groups.set(code, { keys: new Map(), epoch: 0, roster: null, needsRotation: false, lastHash: null, lastId: 0, busy: null });
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
async _groupFetchKeys(code) {
  const st = this._groupState(code);
  const since = st.keys.size ? Math.max(...st.keys.keys()) : 0;
  const r = await this._groupReq('get-group-keys', { code, sinceEpoch: since }, { 'group-keys': d => d.code === code });
  if (!r) return st;
  st.epoch = r.data.currentEpoch;
  st.needsRotation = !!r.data.needsRotation;
  const roster = st.roster || await this._groupRoster(code);
  for (const k of r.data.keys) {
    try {
      const jwk = await this._groupPublicKey(k.wrappedBy, roster);
      if (!jwk) continue;
      st.keys.set(k.epoch, await HavenGroupCrypto.unwrapEpochKey(k.wrappedKey, await this.e2e.pairKey(k.wrappedBy, jwk)));
    } catch { }
  }
  if (st.epoch && !st.keys.has(st.epoch) && !st.needsRotation && !st.rewrapAsked) {
    st.rewrapAsked = true;
    this.socket.emit('request-group-rewrap', { code });
  }
  return st;
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
  const pins = this._e2ePins?.() || {};
  const epochKey = await HavenGroupCrypto.generateEpochKey();
  const keys = [];
  for (const m of roster.members) {
    const jwk = await this._groupPublicKey(m.id, roster);
    if (!jwk) return false;
    if (m.id !== this.user.id && pins[m.id] && pins[m.id] !== this._e2ePinFingerprint(jwk)) {
      this._showToast(t('groups.key_changed', { name: this._getNickname(m.id, m.username) }), 'warning');
      return false;
    }
    keys.push({ recipientId: m.id, wrappedKey: await HavenGroupCrypto.wrapEpochKey(epochKey, await this.e2e.pairKey(m.id, jwk)) });
  }
  const epoch = roster.epoch + 1;
  const r = await this._groupReq('publish-group-epoch', { code, epoch, keys }, {
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
async _groupDecrypt(code, content, senderId, msgId = 0) {
  const st = this._groupState(code);
  let env;
  try { env = JSON.parse(content); } catch { return { ok: false, reason: 'malformed' }; }
  if (!st.keys.has(env.e)) await this._groupFetchKeys(code);
  const key = st.keys.get(env.e);
  if (!key) return { ok: false, reason: 'no-key' };
  const ch = this.channels.find(c => c.code === code);
  const attempt = async () => {
    const signers = await this._groupSignerKeys(senderId);
    if (!signers.length) return { ok: false, reason: 'no-signer' };
    // Fail closed: a message that verifies under none of its author's
    // recorded keys stays hidden.
    let res = { ok: false, reason: 'bad-signature' };
    for (const signer of signers) {
      res = await HavenGroupCrypto.decryptGroupMessage(env, { epochKey: key, channelId: ch?.id, senderId, signingPublicJwk: signer });
      if (res.reason !== 'bad-signature') break;
    }
    return res;
  };
  let r = await attempt();
  // The author may have changed keys since we last asked. Ask again, but not
  // for every message in a page of history.
  const asked = this._signerAskedAt?.get(senderId) || 0;
  if (!r.ok && (r.reason === 'bad-signature' || r.reason === 'no-signer') && Date.now() - asked > 30000) {
    if (!this._signerAskedAt) this._signerAskedAt = new Map();
    this._signerAskedAt.set(senderId, Date.now());
    this._signerKeys?.delete(senderId);
    r = await attempt();
  }
  if (r.ok && msgId >= st.lastId) { st.lastId = msgId; st.lastHash = await HavenGroupCrypto.envelopeHash(content); }
  return r;
},
async _decryptGroupMessages(messages, ch) {
  const fail = (r) => t(r.reason === 'no-key' ? 'groups.no_key' : 'groups.cannot_verify');
  for (const msg of messages) {
    if (this._isGroupEnvelope(msg.content)) {
      const r = await this._groupDecrypt(ch.code, msg.content, msg.user_id, msg.id || 0);
      msg.content = r.ok ? r.plaintext : fail(r);
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
      msg.replyContext.content = r.ok ? r.plaintext : fail(r);
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

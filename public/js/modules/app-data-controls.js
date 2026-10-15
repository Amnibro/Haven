// Settings, Data & privacy: Delete my messages (all, or older than a choice),
// Auto-delete my messages, Export my data, and Blocked users. Plus what a
// block looks like everywhere else: a blocked person's messages in channels
// and groups fold into a "Blocked message · Show" row, their typing is not
// shown, and they make no sound, pop-up or unread count. Their 1:1 DM is
// closed by the server instead (src/userBlocks.js).
//
// The same protocol is used by the Android and iOS apps, so the choices and
// the wording match theirs.

// Picker values are days; 0 is "All my messages" / "Off".
const PURGE_CHOICES = [0, 1, 7, 30, 90, 365];
const AUTO_DELETE_CHOICES = [0, 1, 7, 30, 90, 365];
const MESSAGE_VIEWS = '#messages, #thread-messages, #dm-pip-messages';

export default {

// ── Blocked set ────────────────────────────────────────
_blockedIds() {
  if (!this._blockedSet) this._blockedSet = new Set();
  return this._blockedSet;
},

_isBlocked(userId) {
  return userId != null && this._blockedIds().has(Number(userId));
},

_setBlockedIds(ids) {
  this._blockedSet = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger));
  this._applyBlockedRows();
  if (document.getElementById('blocked-users-list')?.offsetParent) this._loadBlockedUsers();
  this._refreshOpenProfileBlockBtn?.();
},

// "1 day", "30 days", "1 year": the same labels the pickers show.
_dataDaysLabel(days) {
  if (days === 365) return t('settings.data_privacy.choice_1y');
  return days === 1 ? t('settings.data_privacy.choice_1d') : t('settings.data_privacy.choice_days', { n: days });
},

// ── Blocked messages ───────────────────────────────────
// A view of a 1:1 DM is left alone: the DM itself is closed by the server,
// and its history is the reader's own conversation.
_blockedRowsApply(container) {
  if (!container) return true;
  const code = container.id === 'dm-pip-messages' ? this._activeDMPip : this.currentChannel;
  const ch = (this.channels || []).find(c => c.code === code);
  return !(ch && ch.is_dm && !ch.is_group);
},

_foldBlockedMessage(el) {
  if (!el || el.dataset.blockedShown === '1' || el.classList.contains('msg-blocked')) return;
  if (!this._isBlocked(el.dataset.userId)) return;
  if (!this._blockedRowsApply(el.closest(MESSAGE_VIEWS))) return;
  el.classList.add('msg-blocked');
  const row = document.createElement('div');
  row.className = 'msg-blocked-row';
  row.innerHTML = `<span>${this._escapeHtml(t('blocks.blocked_message'))}</span> · <button type="button" class="msg-blocked-show">${this._escapeHtml(t('blocks.show'))}</button>`;
  row.querySelector('.msg-blocked-show').addEventListener('click', (e) => {
    e.stopPropagation();
    el.dataset.blockedShown = '1';
    el.classList.remove('msg-blocked');
    row.remove();
  });
  row.addEventListener('dblclick', (e) => e.stopPropagation());
  el.prepend(row);
},

// Fold every rendered message from a blocked person, and unfold the ones
// from people no longer blocked.
_applyBlockedRows() {
  document.querySelectorAll('.msg-blocked').forEach((el) => {
    if (this._isBlocked(el.dataset.userId)) return;
    el.classList.remove('msg-blocked');
    el.querySelector(':scope > .msg-blocked-row')?.remove();
  });
  if (!this._blockedIds().size) return;
  document.querySelectorAll(MESSAGE_VIEWS).forEach((view) => {
    view.querySelectorAll('[data-msg-id][data-user-id]').forEach((el) => this._foldBlockedMessage(el));
  });
},

// Messages are drawn by several modules (chat, threads, the DM pop-out,
// forums); watching for new rows here covers all of them without each one
// having to know about blocks.
_watchBlockedRows() {
  if (this._blockedObserver || typeof MutationObserver === 'undefined') return;
  this._blockedObserver = new MutationObserver((records) => {
    if (!this._blockedIds().size) return;
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('[data-msg-id][data-user-id]')) this._foldBlockedMessage(node);
        else if (node.querySelectorAll) node.querySelectorAll('[data-msg-id][data-user-id]').forEach((el) => this._foldBlockedMessage(el));
      }
    }
  });
  this._blockedObserver.observe(document.body, { childList: true, subtree: true });
},

// ── Block / unblock ────────────────────────────────────
async _toggleBlockUser(userId, name) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id === this.user?.id) return;
  if (this._isBlocked(id)) {
    this.socket.emit('unblock-user', { userId: id }, (res) => {
      if (!res || res.error) return this._showToast(res?.error || t('blocks.failed'), 'error');
      this._setBlockedIds(res.blockedIds);
      this._showToast(t('blocks.unblocked', { name }), 'success');
    });
    return;
  }
  const ok = await this._showConfirmModal(t('blocks.confirm_title', { name }), t('blocks.confirm_body'), { danger: true, confirmLabel: t('blocks.block') });
  if (!ok) return;
  this.socket.emit('block-user', { userId: id }, (res) => {
    if (!res || res.error) return this._showToast(res?.error || t('blocks.failed'), 'error');
    this._setBlockedIds(res.blockedIds);
    this._showToast(t('blocks.blocked', { name }), 'success');
  });
},

_refreshOpenProfileBlockBtn() {
  const btn = document.querySelector('#profile-popup .profile-block-btn');
  if (!btn) return;
  const blocked = this._isBlocked(btn.dataset.blockUid);
  btn.textContent = `${blocked ? '✅' : '🚫'} ${t(blocked ? 'blocks.unblock' : 'blocks.block')}`;
},

// ── Settings section ───────────────────────────────────
_loadBlockedUsers() {
  const list = document.getElementById('blocked-users-list');
  if (!list || !this.socket) return;
  this.socket.emit('get-blocked-users', {}, (res) => {
    const users = Array.isArray(res?.users) ? res.users : [];
    if (!users.length) {
      list.innerHTML = `<p class="muted-text">${this._escapeHtml(t('settings.data_privacy.blocked_none'))}</p>`;
      return;
    }
    list.innerHTML = users.map(u => `<div class="blocked-user-item" data-uid="${Number(u.id)}">
      <span class="blocked-user-name">${this._escapeHtml(u.displayName || u.username)}</span>
      <span class="blocked-user-handle">@${this._escapeHtml(u.username)}</span>
      <button type="button" class="btn-xs blocked-user-unblock">${this._escapeHtml(t('blocks.unblock'))}</button>
    </div>`).join('');
    list.querySelectorAll('.blocked-user-unblock').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.blocked-user-item');
        const name = row.querySelector('.blocked-user-name')?.textContent || '';
        this._toggleBlockUser(Number(row.dataset.uid), name);
      });
    });
  });
},

_renderDataControls(state) {
  const allowed = !!state?.allowSelfPurge && !state?.isGuest;
  const purgeBlock = document.getElementById('self-purge-block');
  if (purgeBlock) purgeBlock.style.display = allowed ? '' : 'none';
  const sel = document.getElementById('auto-delete-select');
  if (sel && state && Number.isInteger(state.autoDeleteDays)) {
    sel.value = String(state.autoDeleteDays);
    sel.dataset.current = String(state.autoDeleteDays);
  }
  const exportBlock = document.getElementById('data-export-block');
  if (exportBlock) exportBlock.style.display = (state?.isGuest || this.user?.isGuest) ? 'none' : '';
},

_loadDataControls() {
  if (!this.socket) return;
  this.socket.emit('get-data-controls', {}, (res) => {
    if (res && !res.error) this._renderDataControls(res);
  });
  this._loadBlockedUsers();
},

// A password box over a short warning; resolves with the password, or null
// when cancelled. Shared by Delete my messages and Auto-delete.
_askDataPassword({ title, desc, confirmLabel, run }) {
  document.querySelector('.data-password-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay data-password-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:380px">
      <h3>${this._escapeHtml(title)}</h3>
      <p class="modal-desc">${this._escapeHtml(desc)}</p>
      <div class="form-group compact">
        <input type="password" class="data-password-input" placeholder="${this._escapeHtml(t('settings.delete_account_section.password_placeholder'))}" maxlength="128" autocomplete="current-password">
      </div>
      <small class="settings-hint data-password-status" style="display:block;margin-bottom:8px"></small>
      <div class="modal-actions">
        <button class="btn-sm data-password-cancel">${this._escapeHtml(t('modals.common.cancel'))}</button>
        <button class="btn-sm btn-danger-fill data-password-confirm">${this._escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('.data-password-input');
  const status = overlay.querySelector('.data-password-status');
  const confirmBtn = overlay.querySelector('.data-password-confirm');
  const close = () => { overlay.remove(); };
  overlay.querySelector('.data-password-cancel').addEventListener('click', () => { close(); run(null); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); run(null); } });
  const submit = () => {
    const pw = input.value;
    if (!pw) { status.textContent = t('settings.delete_account_section.password_required'); return; }
    status.textContent = t('settings.data_privacy.working');
    confirmBtn.disabled = true;
    run(pw, (error) => {
      if (error) { status.textContent = error; confirmBtn.disabled = false; return; }
      close();
    });
  };
  confirmBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus(), 0);
},

_startSelfPurge() {
  const days = Number(document.getElementById('self-purge-range')?.value) || 0;
  if (!PURGE_CHOICES.includes(days)) return;
  const confirmText = days
    ? t('settings.data_privacy.purge_confirm_older', { label: this._dataDaysLabel(days) })
    : t('settings.data_privacy.purge_confirm_all');
  this._askDataPassword({
    title: `🧹 ${t('settings.data_privacy.purge_title')}`,
    desc: confirmText,
    confirmLabel: t('settings.data_privacy.purge_btn'),
    run: (pw, done) => {
      if (pw === null) return;
      const payload = days ? { password: pw, olderThanDays: days } : { password: pw };
      this.socket.emit('self-purge-messages', payload, (res) => {
        if (!res || res.error) return done(res?.error || t('settings.self_purge.failed'));
        done();
        this._showToast(res.kept
          ? t('settings.self_purge.done_kept', { n: res.deleted, kept: res.kept })
          : t('settings.self_purge.done', { n: res.deleted }), 'success');
      });
    },
  });
},

_onAutoDeleteChange(sel) {
  const days = Number(sel.value);
  const previous = Number(sel.dataset.current || 0);
  const status = document.getElementById('auto-delete-status');
  if (status) status.textContent = '';
  if (!AUTO_DELETE_CHOICES.includes(days)) { sel.value = String(previous); return; }
  const saved = (res) => {
    sel.dataset.current = String(res.autoDeleteDays);
    sel.value = String(res.autoDeleteDays);
    this._showToast(res.autoDeleteDays
      ? t('settings.data_privacy.auto_delete_on', { label: this._dataDaysLabel(res.autoDeleteDays) })
      : t('settings.data_privacy.auto_delete_off'), 'success');
  };
  // Off needs no password.
  if (!days) {
    this.socket.emit('set-auto-delete-messages', { days: 0 }, (res) => {
      if (res && !res.error) return saved(res);
      sel.value = String(previous);
      if (status) status.textContent = res?.error || t('settings.data_privacy.auto_delete_failed');
    });
    return;
  }
  // Anything else asks for the password first; the picker goes back to what
  // it was unless the server accepts the change.
  this._askDataPassword({
    title: `⏳ ${t('settings.data_privacy.auto_delete_title')}`,
    desc: t('settings.data_privacy.auto_delete_confirm', { label: this._dataDaysLabel(days) }),
    confirmLabel: t('settings.data_privacy.auto_delete_btn'),
    run: (pw, done) => {
      if (pw === null) { sel.value = String(previous); return; }
      this.socket.emit('set-auto-delete-messages', { days, password: pw }, (res) => {
        if (!res || res.error) return done(res?.error || t('settings.data_privacy.auto_delete_failed'));
        done();
        saved(res);
      });
    },
  });
},

async _downloadMyData() {
  const btn = document.getElementById('export-data-btn');
  const status = document.getElementById('export-data-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = t('settings.data_privacy.export_working');
  try {
    const res = await fetch('/api/me/export', { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (status) status.textContent = body.error || t('settings.data_privacy.export_failed');
      return;
    }
    const blob = await res.blob();
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'haven-export.json';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    if (status) status.textContent = t('settings.data_privacy.export_done');
  } catch (err) {
    console.warn('[data] export failed', err);
    if (status) status.textContent = t('settings.data_privacy.export_failed');
  } finally {
    if (btn) btn.disabled = false;
  }
},

_setupDataControls() {
  if (this._dataControlsReady) return;
  this._dataControlsReady = true;
  this._watchBlockedRows();

  this.socket.on('session-info', (data) => {
    if (Array.isArray(data?.blockedUserIds)) this._setBlockedIds(data.blockedUserIds);
  });
  this.socket.on('blocked-users-updated', (data) => this._setBlockedIds(data?.blockedIds));
  this.socket.on('data-controls-updated', (data) => {
    const sel = document.getElementById('auto-delete-select');
    if (sel && Number.isInteger(data?.autoDeleteDays)) {
      sel.value = String(data.autoDeleteDays);
      sel.dataset.current = String(data.autoDeleteDays);
    }
  });

  document.getElementById('self-purge-btn')?.addEventListener('click', () => this._startSelfPurge());
  const autoSel = document.getElementById('auto-delete-select');
  autoSel?.addEventListener('change', () => this._onAutoDeleteChange(autoSel));
  document.getElementById('export-data-btn')?.addEventListener('click', () => this._downloadMyData());

  document.getElementById('settings-nav')?.addEventListener('click', (e) => {
    if (e.target.closest('.settings-nav-item')?.dataset.target === 'section-data-privacy') this._loadDataControls();
  });
  document.getElementById('open-settings-btn')?.addEventListener('click', () => this._loadDataControls());
},

};

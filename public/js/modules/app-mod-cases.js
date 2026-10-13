// Moderation history (#5759): warn a member, keep notes, and see everything
// that was done to someone, kept after a mute or ban is lifted. The member
// gets a warning as a notice only they see, also when they were away at the
// time, and can look at their own record (without notes or names).
// Server side: src/modCases.js, src/socketHandlers/modCases.js.

const TYPE_ICON = { warn: '⚠️', note: '📝', kick: '👢', mute: '🔇', unmute: '🔊', ban: '⛔', unban: '✅' };

export default {

_setupModCases() {
  this.socket.on('mod-warning', (w) => this._showModWarning(w));
  const fetchPending = () => {
    this.socket.emit('get-pending-warnings', {}, (res) => {
      (res && Array.isArray(res.warnings) ? res.warnings : []).forEach(w => this._showModWarning(w));
    });
  };
  this.socket.on('connect', fetchPending);
  if (this.socket.connected) fetchPending();
},

_modOverlay(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  overlay.innerHTML = `<div class="modal mod-cases-modal">${html}</div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return { overlay, close };
},

// One warning at a time; the next waits until this one is dismissed.
_showModWarning(w) {
  if (!w || !Number.isInteger(w.id)) return;
  this._modWarningQueue = this._modWarningQueue || [];
  if (this._modWarningQueue.some(q => q.id === w.id) || this._modWarningShown === w.id) return;
  this._modWarningQueue.push(w);
  if (!this._modWarningShown) this._nextModWarning();
},

_nextModWarning() {
  const w = this._modWarningQueue.shift();
  this._modWarningShown = w ? w.id : null;
  if (!w) return;
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const when = w.createdAt ? new Date(w.createdAt.endsWith('Z') ? w.createdAt : w.createdAt.replace(' ', 'T') + 'Z').toLocaleString() : '';
  const { overlay, close } = this._modOverlay(`
    <h3 style="margin-top:0">⚠️ ${esc(t('mod_cases.warning_title'))}</h3>
    <p class="muted-text" style="margin:0 0 8px">${esc(t('mod_cases.warning_intro'))}</p>
    <blockquote class="mod-case-reason">${esc(w.reason)}</blockquote>
    ${when ? `<p class="muted-text" style="margin:8px 0 0;font-size:.78rem">${esc(when)}</p>` : ''}
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn-sm" data-act="history">${esc(t('mod_cases.my_history'))}</button>
      <button class="btn-sm btn-accent" data-act="ok">${esc(t('mod_cases.understood'))}</button>
    </div>`);
  const ack = () => {
    this.socket.emit('ack-mod-warning', { id: w.id });
    close();
    this._nextModWarning();
  };
  overlay.querySelector('[data-act="ok"]').addEventListener('click', ack);
  overlay.querySelector('[data-act="history"]').addEventListener('click', () => {
    ack();
    this._openModHistory(this.user.id, this.user.displayName || this.user.username);
  });
},

_openWarnDialog(userId, name) {
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const levels = [1, 2, 3, 5, 10];
  const { overlay, close } = this._modOverlay(`
    <h3 style="margin-top:0">⚠️ ${esc(t('mod_cases.warn_title', { name }))}</h3>
    <p class="muted-text" style="margin:0 0 8px">${esc(t('mod_cases.warn_desc'))}</p>
    <textarea class="settings-textarea mod-case-input" rows="3" maxlength="500" placeholder="${esc(t('mod_cases.reason_placeholder'))}"></textarea>
    <label class="mod-case-severity">${esc(t('mod_cases.severity'))}
      <select class="settings-select">${levels.map(n => `<option value="${n}">${n}</option>`).join('')}</select>
    </label>
    <small class="settings-hint" style="display:block">${esc(t('mod_cases.severity_hint'))}</small>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-sm" data-act="cancel">${esc(t('modals.common.cancel'))}</button>
      <button class="btn-sm btn-accent" data-act="warn">${esc(t('mod_cases.warn'))}</button>
    </div>`);
  const input = overlay.querySelector('textarea');
  setTimeout(() => input.focus(), 0);
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-act="warn"]').addEventListener('click', () => {
    const reason = input.value.trim();
    if (!reason) { this._showToast(t('mod_cases.reason_required'), 'error'); input.focus(); return; }
    const severity = parseInt(overlay.querySelector('select').value, 10) || 1;
    this.socket.emit('warn-user', { userId, reason, severity }, (res) => {
      if (!res || !res.ok) { this._showToast(res?.error || t('mod_cases.failed'), 'error'); return; }
      close();
      this._showToast(t('mod_cases.warned', { name, points: res.points }), 'success');
    });
  });
},

_openModHistory(userId, name) {
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const self = userId === this.user?.id;
  const { overlay, close } = this._modOverlay(`
    <h3 style="margin-top:0">📋 ${esc(self ? t('mod_cases.my_history') : t('mod_cases.history_title', { name }))}</h3>
    <div class="mod-case-summary muted-text"></div>
    <div class="mod-case-list"><p class="muted-text">${esc(t('mod_cases.loading'))}</p></div>
    <div class="mod-case-note" hidden>
      <textarea class="settings-textarea mod-case-input" rows="2" maxlength="500" placeholder="${esc(t('mod_cases.note_placeholder'))}"></textarea>
      <button class="btn-sm" data-act="note">📝 ${esc(t('mod_cases.add_note'))}</button>
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-sm" data-act="close">${esc(t('modals.common.close'))}</button>
    </div>`);
  overlay.querySelector('[data-act="close"]').addEventListener('click', close);

  const render = () => {
    this.socket.emit('get-mod-history', { userId }, (res) => {
      if (!overlay.isConnected) return;
      const listEl = overlay.querySelector('.mod-case-list');
      if (!res || !res.ok) { listEl.innerHTML = `<p class="muted-text">${esc(res?.error || t('mod_cases.failed'))}</p>`; return; }
      overlay.querySelector('.mod-case-summary').textContent = t('mod_cases.points', { points: res.points, days: res.pointsDays });
      overlay.querySelector('.mod-case-note').hidden = !res.canAdd;
      if (!res.cases.length) { listEl.innerHTML = `<p class="muted-text">${esc(t(self ? 'mod_cases.none_self' : 'mod_cases.none'))}</p>`; return; }
      listEl.innerHTML = res.cases.map(c => {
        const when = new Date(c.createdAt.endsWith('Z') ? c.createdAt : c.createdAt.replace(' ', 'T') + 'Z').toLocaleString();
        const meta = [
          t(`mod_cases.type_${c.type}`),
          c.severity ? t('mod_cases.points_short', { points: c.severity }) : '',
          c.durationMinutes ? t('mod_cases.minutes', { minutes: c.durationMinutes }) : '',
          c.actor ? t('mod_cases.by', { name: c.actor }) : '',
          when,
        ].filter(Boolean).join(' · ');
        const revoked = c.revoked ? `<span class="mod-case-revoked">${esc(c.revokedBy ? t('mod_cases.revoked_by', { name: c.revokedBy }) : t('mod_cases.revoked'))}</span>` : '';
        const revokeBtn = res.canRevoke && !c.revoked && c.type !== 'note'
          ? `<button class="btn-xs" data-revoke="${c.id}">${esc(t('mod_cases.revoke'))}</button>` : '';
        return `<div class="mod-case-row${c.revoked ? ' is-revoked' : ''}">
          <span class="mod-case-icon">${TYPE_ICON[c.type] || '•'}</span>
          <div class="mod-case-body">
            <div class="mod-case-meta">${esc(meta)} ${revoked}</div>
            ${c.reason ? `<div class="mod-case-text">${esc(c.reason)}</div>` : ''}
          </div>
          ${revokeBtn}
        </div>`;
      }).join('');
      listEl.querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', async () => {
        if (!(await this._showConfirmModal(t('mod_cases.revoke_confirm'), '', { confirmLabel: t('mod_cases.revoke') }))) return;
        this.socket.emit('revoke-mod-case', { id: parseInt(btn.dataset.revoke, 10) }, (r) => {
          if (!r || !r.ok) { this._showToast(r?.error || t('mod_cases.failed'), 'error'); return; }
          render();
        });
      }));
    });
  };
  overlay.querySelector('[data-act="note"]').addEventListener('click', () => {
    const box = overlay.querySelector('.mod-case-note textarea');
    const text = box.value.trim();
    if (!text) return;
    this.socket.emit('add-mod-note', { userId, text }, (res) => {
      if (!res || !res.ok) { this._showToast(res?.error || t('mod_cases.failed'), 'error'); return; }
      box.value = '';
      render();
    });
  });
  render();
},

};

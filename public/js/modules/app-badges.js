// ═══════════════════════════════════════════════════════════
// Profile badges (#5632)
//
// Small icons on the profile card that show real history on the server:
// earned (time as a member, messages posted, forum likes received), coming
// with a role, or given by hand. Nothing is ever bought.
//   - The card shows a row of badges; clicking one tells what it is and how
//     it was earned. On your own card you can hide one, or show it again.
//   - Settings > Admin > Badges lists, makes, edits and deletes them.
//   - Right-click a member > Badges gives or takes back hand-given ones.
// Server side: src/badges.js, src/socketHandlers/badges.js, src/routes/badges.js.
// ═══════════════════════════════════════════════════════════

const KINDS = ['account_age', 'messages', 'forum_likes', 'role', 'manual'];
const EARNED = ['account_age', 'messages', 'forum_likes'];
const ICON_PX = 64;

// Days to the largest whole unit: 365 is a year, 90 is three months.
function splitDays(days) {
  if (days >= 365 && days % 365 === 0) return { n: days / 365, unit: 'years' };
  if (days >= 30 && days % 30 === 0) return { n: days / 30, unit: 'months' };
  return { n: days, unit: 'days' };
}
const UNIT_DAYS = { days: 1, months: 30, years: 365 };

export default {

_setupBadges() {
  const section = document.getElementById('section-badges');
  if (!section) return;
  document.getElementById('badge-new-btn')?.addEventListener('click', () => this._openBadgeEditor(null));
  document.getElementById('badge-admin-list')?.addEventListener('click', (e) => this._onBadgeAdminClick(e));
  document.getElementById('badge-admin-list')?.addEventListener('change', (e) => {
    const box = e.target.closest('.badge-admin-enabled');
    if (box) this._saveBadgeChange({ badgeId: Number(box.dataset.badgeId), enabled: box.checked });
  });
  // Load whenever the section comes into view: from the nav, from search, or
  // when it is the first section the Admin tab opens on.
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      if (entries.some(en => en.isIntersecting)) this._loadBadgeAdmin();
    }).observe(section);
  }
},

_canManageBadges() {
  return !!(this.user?.isAdmin || this._hasPerm?.('manage_badges'));
},

// ── Shared bits ─────────────────────────────────────────

_badgeIconHtml(b, cls = 'badge-icon') {
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  let src = null;
  if (b.iconType === 'builtin' && /^[a-z]+$/.test(b.icon || '')) src = `/img/badges/${b.icon}.svg`;
  else if (b.iconType === 'image' && /^\/uploads\/badges\/[\w.-]+$/.test(b.icon || '')) src = b.icon;
  if (src) return `<img class="${cls}" src="${esc(src)}" alt="" draggable="false">`;
  return `<span class="${cls} badge-icon-emoji" aria-hidden="true">${esc(b.icon)}</span>`;
},

_badgeSpanText(days) {
  const { n, unit } = splitDays(days);
  return t(n === 1 ? `badges.span.${unit}_one` : `badges.span.${unit}`, { n: n.toLocaleString() });
},

// How a badge is had, in a short sentence.
_badgeHowText(b) {
  const n = Number(b.threshold) || 0;
  switch (b.kind) {
    case 'account_age': return t('badges.how.account_age', { span: this._badgeSpanText(n) });
    case 'messages': return t('badges.how.messages', { count: n.toLocaleString() });
    case 'forum_likes': return t('badges.how.forum_likes', { count: n.toLocaleString() });
    case 'role': return b.roleName ? t('badges.how.role', { role: b.roleName }) : t('badges.how.role_missing');
    default: return t('badges.how.manual');
  }
},

// ── Profile card ────────────────────────────────────────

_badgeRowHtml(profile) {
  const list = Array.isArray(profile?.badges) ? profile.badges : [];
  if (!list.length) return '';
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const items = list.map(b => {
    const tip = b.description ? `${b.name}: ${b.description}` : b.name;
    return `<button type="button" class="profile-badge${b.hidden ? ' is-hidden' : ''}" data-badge-id="${Number(b.id)}" title="${esc(tip)}" aria-label="${esc(b.name)}">${this._badgeIconHtml(b)}</button>`;
  }).join('');
  return `<div class="profile-popup-section-label">${esc(t('badges.profile_label'))}</div>
    <div class="profile-badges">${items}</div>
    <div class="profile-badge-detail" hidden></div>`;
},

_bindBadgeRow(popup, profile) {
  const row = popup.querySelector('.profile-badges');
  const detail = popup.querySelector('.profile-badge-detail');
  if (!row || !detail) return;
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const self = profile.id === this.user?.id;
  let openId = null;

  const show = (b) => {
    openId = b.id;
    row.querySelectorAll('.profile-badge').forEach(el => el.classList.toggle('is-open', Number(el.dataset.badgeId) === b.id));
    detail.innerHTML = `
      <div class="profile-badge-detail-head">${this._badgeIconHtml(b, 'badge-icon badge-icon-lg')}<strong>${esc(b.name)}</strong></div>
      ${b.description ? `<div class="profile-badge-detail-desc">${esc(b.description)}</div>` : ''}
      <div class="profile-badge-detail-how">${esc(this._badgeHowText(b))}</div>
      ${self ? `<button type="button" class="btn-sm profile-badge-hide">${esc(t(b.hidden ? 'badges.show_on_profile' : 'badges.hide_on_profile'))}</button>
        ${b.hidden ? `<div class="profile-badge-detail-how">${esc(t('badges.hidden_note'))}</div>` : ''}` : ''}`;
    detail.hidden = false;
    detail.querySelector('.profile-badge-hide')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const want = !b.hidden;
      this.socket.emit('set-badge-hidden', { badgeId: b.id, hidden: want }, (res) => {
        if (!res || !res.ok) { this._showToast(res?.error || t('badges.save_failed'), 'error'); return; }
        b.hidden = want;
        row.querySelector(`.profile-badge[data-badge-id="${b.id}"]`)?.classList.toggle('is-hidden', want);
        show(b);
      });
    });
  };

  row.addEventListener('click', (e) => {
    const btn = e.target.closest('.profile-badge');
    if (!btn) return;
    e.stopPropagation();
    const b = profile.badges.find(x => x.id === Number(btn.dataset.badgeId));
    if (!b) return;
    if (openId === b.id) {
      openId = null;
      detail.hidden = true;
      btn.classList.remove('is-open');
      return;
    }
    show(b);
  });
},

// ── Admin: Settings > Badges ────────────────────────────

_loadBadgeAdmin() {
  if (!this._canManageBadges()) return;
  // One request at a time; a fresh list at most every few seconds.
  if (this._badgeAdminLoading || (this._badgeAdminLoadedAt && Date.now() - this._badgeAdminLoadedAt < 5000)) return;
  this._badgeAdminLoading = true;
  this.socket.emit('get-badges', {}, (res) => {
    this._badgeAdminLoading = false;
    const list = document.getElementById('badge-admin-list');
    if (!res || !res.ok) {
      if (list) list.innerHTML = `<p class="muted-text">${this._escapeHtml(res?.error || t('badges.admin.load_failed'))}</p>`;
      return;
    }
    this._badgeAdminLoadedAt = Date.now();
    this._badgeAdmin = res;
    this._renderBadgeAdmin();
  });
},

// May the caller change this badge? Role badges only for roles below them.
_badgeEditable(b) {
  const data = this._badgeAdmin;
  if (!data || data.canEditAll || b.kind !== 'role' || b.roleId == null) return true;
  const role = (data.roles || []).find(r => r.id === b.roleId);
  return !role || role.level < data.myLevel;
},

_renderBadgeAdmin() {
  const list = document.getElementById('badge-admin-list');
  const data = this._badgeAdmin;
  if (!list || !data) return;
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  if (!data.badges.length) {
    list.innerHTML = `<p class="muted-text">${esc(t('badges.admin.none'))}</p>`;
    return;
  }
  const groups = [
    { key: 'earned', kinds: EARNED },
    { key: 'role', kinds: ['role'] },
    { key: 'manual', kinds: ['manual'] },
  ];
  list.innerHTML = groups.map(g => {
    const items = data.badges.filter(b => g.kinds.includes(b.kind));
    if (!items.length) return '';
    return `<div class="badge-admin-group">
      <div class="badge-admin-group-label">${esc(t(`badges.admin.group_${g.key}`))}</div>
      ${items.map(b => {
        const editable = this._badgeEditable(b);
        const lock = editable ? '' : ` disabled title="${esc(t('badges.admin.role_above_you'))}"`;
        return `<div class="badge-admin-row${b.enabled ? '' : ' is-off'}" data-badge-id="${b.id}">
          ${this._badgeIconHtml(b, 'badge-icon badge-icon-lg')}
          <div class="badge-admin-text">
            <div class="badge-admin-name">${esc(b.name)}</div>
            <div class="badge-admin-how">${esc(this._badgeHowText(b))}${b.description ? ` · ${esc(b.description)}` : ''}</div>
          </div>
          <label class="toggle-row badge-admin-switch" title="${esc(t('badges.admin.enabled'))}">
            <span>${esc(t(b.enabled ? 'badges.admin.on' : 'badges.admin.off'))}</span>
            <input type="checkbox" class="badge-admin-enabled" data-badge-id="${b.id}" aria-label="${esc(t('badges.admin.enabled'))}"${b.enabled ? ' checked' : ''}${editable ? '' : ' disabled'}>
          </label>
          <div class="badge-admin-actions">
            ${b.kind === 'manual' ? `<button class="btn-sm badge-admin-holders">${esc(t('badges.admin.holders', { n: b.holders }))}</button>` : ''}
            <button class="btn-sm badge-admin-edit"${lock}>${esc(t('badges.admin.edit'))}</button>
            <button class="btn-sm btn-danger-fill badge-admin-delete"${lock}>${esc(t('badges.admin.delete'))}</button>
          </div>
          <div class="badge-admin-holder-list" hidden></div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
},

_onBadgeAdminClick(e) {
  const row = e.target.closest('.badge-admin-row');
  if (!row) return;
  const id = Number(row.dataset.badgeId);
  const b = this._badgeAdmin?.badges.find(x => x.id === id);
  if (!b) return;
  if (e.target.closest('.badge-admin-edit')) this._openBadgeEditor(b);
  else if (e.target.closest('.badge-admin-delete')) this._deleteBadge(b);
  else if (e.target.closest('.badge-admin-holders')) this._toggleBadgeHolders(b, row);
  else if (e.target.closest('.badge-holder-revoke')) {
    const userId = Number(e.target.closest('.badge-holder-revoke').dataset.userId);
    this.socket.emit('revoke-badge', { userId, badgeId: id }, (res) => {
      if (!res || !res.ok) { this._showToast(res?.error || t('badges.save_failed'), 'error'); return; }
      b.holders = Math.max(0, (b.holders || 1) - 1);
      this._showToast(t('badges.taken_back'), 'success');
      this._toggleBadgeHolders(b, row, true);
      const btn = row.querySelector('.badge-admin-holders');
      if (btn) btn.textContent = t('badges.admin.holders', { n: b.holders });
    });
  }
},

_toggleBadgeHolders(b, row, refresh = false) {
  const box = row.querySelector('.badge-admin-holder-list');
  if (!box) return;
  if (!box.hidden && !refresh) { box.hidden = true; return; }
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  box.hidden = false;
  box.innerHTML = `<p class="muted-text">${esc(t('badges.admin.loading'))}</p>`;
  this.socket.emit('get-badge-holders', { badgeId: b.id }, (res) => {
    if (!res || !res.ok) { box.innerHTML = `<p class="muted-text">${esc(res?.error || t('badges.admin.load_failed'))}</p>`; return; }
    if (!res.holders.length) { box.innerHTML = `<p class="muted-text">${esc(t('badges.admin.no_holders'))}</p>`; return; }
    box.innerHTML = res.holders.map(h => `<div class="badge-holder">
        <span class="badge-holder-name">${esc(h.name)}</span>
        <span class="muted-text">${esc(h.grantedBy ? t('badges.admin.given_by', { name: h.grantedBy }) : '')}</span>
        ${h.canRevoke ? `<button class="btn-sm badge-holder-revoke" data-user-id="${Number(h.userId)}">${esc(t('badges.take_back'))}</button>` : ''}
      </div>`).join('');
  });
},

// update-badge with only some fields; the rest stay as they are.
_saveBadgeChange(payload, onDone) {
  this.socket.emit('update-badge', payload, (res) => {
    if (!res || !res.ok) {
      this._showToast(res?.error || t('badges.save_failed'), 'error');
      this._renderBadgeAdmin();
      return;
    }
    this._badgeAdmin = res;
    this._badgeAdminLoadedAt = Date.now();
    this._renderBadgeAdmin();
    onDone?.();
  });
},

async _deleteBadge(b) {
  const ok = await this._showConfirmModal(
    t('badges.admin.delete_title', { name: b.name }),
    t('badges.admin.delete_body'),
    { danger: true, confirmLabel: t('badges.admin.delete') }
  );
  if (!ok) return;
  this.socket.emit('delete-badge', { badgeId: b.id }, (res) => {
    if (!res || !res.ok) { this._showToast(res?.error || t('badges.save_failed'), 'error'); return; }
    this._badgeAdmin = res;
    this._renderBadgeAdmin();
    this._showToast(t('badges.admin.deleted'), 'success');
  });
},

_badgeOverlay(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '100002';
  overlay.innerHTML = `<div class="modal badge-modal">${html}</div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  return { overlay, close };
},

_openBadgeEditor(badge) {
  const data = this._badgeAdmin;
  if (!data) { this._loadBadgeAdmin(); return; }
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  // No two badges share an icon (the server refuses it), so the icons other
  // badges show are marked here: dimmed built-ins, and a note for an emoji
  // or picture that is taken. Keys match iconKey in src/badges.js.
  const usedBy = new Map(data.badges.filter(x => x.iconKey && (!badge || x.id !== badge.id)).map(x => [x.iconKey, x.name]));
  const firstFree = () => (data.builtinIcons || []).find(k => !usedBy.has(`builtin:${k}`)) || null;
  const b = badge || { name: '', description: '', iconType: 'builtin', icon: firstFree(), kind: 'manual', threshold: null, roleId: null, enabled: true };
  const state = {
    iconType: b.iconType, icon: b.icon,
    image: b.iconType === 'image' ? b.icon : null, imageKey: b.iconType === 'image' ? b.iconKey : null,
    emoji: b.iconType === 'emoji' ? b.icon : '',
  };
  const keyOf = () => {
    if (!state.icon) return null;
    if (state.iconType === 'builtin') return `builtin:${state.icon}`;
    if (state.iconType === 'emoji') return `emoji:${state.icon.replace(/[\uFE0E\uFE0F]/g, '')}`;
    return state.imageKey;
  };
  const span = b.kind === 'account_age' && b.threshold ? splitDays(b.threshold) : { n: 1, unit: 'years' };
  const count = (b.kind === 'messages' || b.kind === 'forum_likes') && b.threshold ? b.threshold : 100;
  const roles = (data.roles || []).filter(r => data.canEditAll || r.level < data.myLevel);

  const { overlay, close } = this._badgeOverlay(`
    <h3 style="margin-top:0">🏅 ${esc(t(badge ? 'badges.editor.edit_title' : 'badges.editor.new_title'))}</h3>
    <div class="badge-editor">
      <div class="badge-editor-preview"><span class="badge-editor-preview-icon"></span><span class="badge-editor-preview-name"></span></div>
      <label class="badge-editor-field">${esc(t('badges.editor.name'))}
        <input type="text" class="settings-text-input" data-f="name" maxlength="32" value="${esc(b.name)}"></label>
      <label class="badge-editor-field">${esc(t('badges.editor.description'))}
        <input type="text" class="settings-text-input" data-f="description" maxlength="120" value="${esc(b.description)}" placeholder="${esc(t('badges.editor.description_placeholder'))}"></label>

      <div class="badge-editor-field">${esc(t('badges.editor.icon'))}
        <div class="badge-editor-tabs" role="tablist">
          ${['builtin', 'emoji', 'image'].map(k => `<button type="button" class="btn-sm badge-editor-tab" data-tab="${k}">${esc(t(`badges.editor.icon_${k}`))}</button>`).join('')}
        </div>
        <div class="badge-editor-pane" data-pane="builtin">
          <div class="badge-editor-builtins">${(data.builtinIcons || []).map(k => {
            const owner = usedBy.get(`builtin:${k}`);
            const tip = owner ? t('badges.editor.icon_used', { name: owner }) : k;
            return `<button type="button" class="badge-editor-builtin${owner ? ' is-used' : ''}" data-icon="${esc(k)}" title="${esc(tip)}"${owner ? ' aria-disabled="true"' : ''}>${this._badgeIconHtml({ iconType: 'builtin', icon: k }, 'badge-icon badge-icon-lg')}</button>`;
          }).join('')}</div>
        </div>
        <div class="badge-editor-pane" data-pane="emoji">
          <input type="text" class="settings-text-input badge-editor-emoji" data-f="emoji" maxlength="16" value="${esc(state.emoji)}" placeholder="🏅">
          <small class="settings-hint">${esc(t('badges.editor.emoji_hint'))}</small>
        </div>
        <div class="badge-editor-pane" data-pane="image">
          <button type="button" class="btn-sm" data-act="upload">${esc(t('badges.editor.upload'))}</button>
          <input type="file" accept="image/png,image/gif,image/webp,image/jpeg" hidden data-f="file">
          <small class="settings-hint">${esc(t('badges.editor.upload_hint'))}</small>
        </div>
        <small class="badge-editor-icon-used" role="alert" hidden></small>
      </div>

      <label class="badge-editor-field">${esc(t('badges.editor.kind'))}
        <select class="settings-select" data-f="kind">
          ${KINDS.map(k => `<option value="${k}"${k === b.kind ? ' selected' : ''}>${esc(t(`badges.kind.${k}`))}</option>`).join('')}
        </select></label>
      <div class="badge-editor-field" data-show="account_age">${esc(t('badges.editor.after'))}
        <div class="badge-editor-inline">
          <input type="number" class="settings-text-input" data-f="span" min="1" max="36500" value="${span.n}">
          <select class="settings-select" data-f="unit">
            ${['days', 'months', 'years'].map(u => `<option value="${u}"${u === span.unit ? ' selected' : ''}>${esc(t(`badges.editor.unit_${u}`))}</option>`).join('')}
          </select>
        </div></div>
      <label class="badge-editor-field" data-show="messages forum_likes">${esc(t('badges.editor.count'))}
        <input type="number" class="settings-text-input" data-f="count" min="1" value="${count}"></label>
      <label class="badge-editor-field" data-show="role">${esc(t('badges.editor.role'))}
        <select class="settings-select" data-f="role">
          ${roles.length ? roles.map(r => `<option value="${r.id}"${r.id === b.roleId ? ' selected' : ''}>${esc(r.name)}</option>`).join('') : `<option value="">${esc(t('badges.editor.no_roles'))}</option>`}
        </select></label>
      <small class="settings-hint badge-editor-kind-hint"></small>
      <label class="toggle-row"><span>${esc(t('badges.editor.enabled'))}</span><input type="checkbox" data-f="enabled"${b.enabled ? ' checked' : ''}></label>
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-sm" data-act="cancel">${esc(t('modals.common.cancel'))}</button>
      <button class="btn-sm btn-accent" data-act="save">${esc(t('badges.editor.save'))}</button>
    </div>`);

  const f = (name) => overlay.querySelector(`[data-f="${name}"]`);
  const preview = () => {
    overlay.querySelector('.badge-editor-preview-icon').innerHTML = state.icon ? this._badgeIconHtml(state, 'badge-icon badge-icon-lg') : '';
    overlay.querySelector('.badge-editor-preview-name').textContent = f('name').value.trim() || t('badges.editor.name');
    overlay.querySelectorAll('.badge-editor-builtin').forEach(el => el.classList.toggle('is-selected', state.iconType === 'builtin' && el.dataset.icon === state.icon));
    const owner = usedBy.get(keyOf());
    const note = overlay.querySelector('.badge-editor-icon-used');
    note.hidden = !owner;
    note.textContent = owner ? t('badges.editor.icon_in_use', { name: owner }) : '';
    overlay.querySelector('[data-act="save"]').disabled = !!owner;
  };
  const setTab = (tab) => {
    overlay.querySelectorAll('.badge-editor-tab').forEach(el => el.classList.toggle('btn-accent', el.dataset.tab === tab));
    overlay.querySelectorAll('.badge-editor-pane').forEach(el => { el.hidden = el.dataset.pane !== tab; });
    if (tab === 'emoji') { state.iconType = 'emoji'; state.icon = f('emoji').value.trim(); }
    if (tab === 'image') { state.iconType = 'image'; state.icon = state.image; }
    if (tab === 'builtin' && state.iconType !== 'builtin') {
      state.iconType = 'builtin';
      state.icon = firstFree();
    }
    preview();
  };
  const syncKind = () => {
    const kind = f('kind').value;
    overlay.querySelectorAll('[data-show]').forEach(el => { el.hidden = !el.dataset.show.split(' ').includes(kind); });
    overlay.querySelector('.badge-editor-kind-hint').textContent = t(`badges.kind_hint.${kind}`);
  };

  overlay.querySelectorAll('.badge-editor-tab').forEach(el => el.addEventListener('click', () => setTab(el.dataset.tab)));
  overlay.querySelector('.badge-editor-builtins').addEventListener('click', (e) => {
    const btn = e.target.closest('.badge-editor-builtin');
    if (!btn || btn.classList.contains('is-used')) return;
    state.iconType = 'builtin';
    state.icon = btn.dataset.icon;
    preview();
  });
  f('emoji').addEventListener('input', () => { state.iconType = 'emoji'; state.icon = f('emoji').value.trim(); preview(); });
  f('name').addEventListener('input', preview);
  f('kind').addEventListener('change', syncKind);
  overlay.querySelector('[data-act="upload"]').addEventListener('click', () => f('file').click());
  f('file').addEventListener('change', async () => {
    const file = f('file').files[0];
    f('file').value = '';
    if (!file) return;
    const up = await this._uploadBadgeIcon(file);
    if (!up || !overlay.isConnected) return;
    state.image = up.path;
    state.imageKey = up.iconKey || null;
    state.iconType = 'image';
    state.icon = up.path;
    preview();
  });
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-act="save"]').addEventListener('click', () => {
    const kind = f('kind').value;
    const payload = {
      name: f('name').value,
      description: f('description').value,
      iconType: state.iconType,
      icon: state.icon || '',
      kind,
      enabled: f('enabled').checked,
    };
    if (kind === 'account_age') payload.threshold = (parseInt(f('span').value, 10) || 0) * UNIT_DAYS[f('unit').value];
    if (kind === 'messages' || kind === 'forum_likes') payload.threshold = parseInt(f('count').value, 10) || 0;
    if (kind === 'role') payload.roleId = parseInt(f('role').value, 10) || null;
    const done = (res) => {
      if (!res || !res.ok) { this._showToast(res?.error || t('badges.save_failed'), 'error'); return; }
      this._badgeAdmin = res;
      this._badgeAdminLoadedAt = Date.now();
      this._renderBadgeAdmin();
      close();
      this._showToast(t('badges.admin.saved'), 'success');
    };
    if (badge) this.socket.emit('update-badge', { ...payload, badgeId: badge.id }, done);
    else this.socket.emit('create-badge', payload, done);
  });

  setTab(state.iconType);
  syncKind();
  setTimeout(() => f('name').focus(), 0);
},

// Shrinks the picture to 64x64 (kept whole, centred) and uploads it.
// Returns { path, iconKey }, or null after telling the user why not.
async _uploadBadgeIcon(file) {
  if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) { this._showToast(t('badges.editor.bad_type'), 'error'); return null; }
  let blob = file;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = ICON_PX; canvas.height = ICON_PX;
    const scale = Math.min(ICON_PX / bmp.width, ICON_PX / bmp.height);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, (ICON_PX - w) / 2, (ICON_PX - h) / 2, w, h);
    bmp.close();
    blob = await new Promise(r => canvas.toBlob(r, 'image/png')) || file;
  } catch (err) {
    // The server checks size and type either way; send the original.
    console.warn('[badges] could not shrink the icon, sending it as is:', err?.message || err);
  }
  if (blob.size > 256 * 1024) { this._showToast(t('badges.editor.too_large'), 'error'); return null; }
  const fd = new FormData();
  fd.append('icon', blob, blob === file ? file.name : 'badge.png');
  try {
    const res = await fetch('/api/upload-badge-icon', { method: 'POST', headers: { Authorization: 'Bearer ' + this.token }, body: fd });
    const out = await res.json();
    if (!res.ok || !out.path) { this._showToast(out.error || t('badges.editor.upload_failed'), 'error'); return null; }
    return { path: out.path, iconKey: out.iconKey };
  } catch (err) {
    console.warn('[badges] icon upload failed:', err?.message || err);
    this._showToast(t('badges.editor.upload_failed'), 'error');
    return null;
  }
},

// ── Giving badges by hand (member menu) ─────────────────

_openMemberBadges(userId, name) {
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const { overlay, close } = this._badgeOverlay(`
    <h3 style="margin-top:0">🏅 ${esc(t('badges.member.title', { name }))}</h3>
    <p class="muted-text" style="margin:0 0 8px">${esc(t('badges.member.intro'))}</p>
    <div class="badge-member-list"><p class="muted-text">${esc(t('badges.admin.loading'))}</p></div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-sm" data-act="close">${esc(t('modals.common.close'))}</button>
    </div>`);
  overlay.querySelector('[data-act="close"]').addEventListener('click', close);
  const listEl = overlay.querySelector('.badge-member-list');
  this.socket.emit('get-member-badges', { userId }, (res) => {
    if (!overlay.isConnected) return;
    if (!res || !res.ok) { listEl.innerHTML = `<p class="muted-text">${esc(res?.error || t('badges.admin.load_failed'))}</p>`; return; }
    if (!res.badges.length) { listEl.innerHTML = `<p class="muted-text">${esc(t('badges.member.none'))}</p>`; return; }
    listEl.innerHTML = res.badges.map(b => `<label class="badge-member-row${b.enabled ? '' : ' is-off'}">
        <input type="checkbox" data-badge-id="${Number(b.id)}"${b.held ? ' checked' : ''}>
        ${this._badgeIconHtml(b, 'badge-icon badge-icon-lg')}
        <span class="badge-member-text"><span class="badge-admin-name">${esc(b.name)}</span>
          ${b.enabled ? '' : `<span class="muted-text">${esc(t('badges.member.switched_off'))}</span>`}</span>
      </label>`).join('');
  });
  listEl.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-badge-id]');
    if (!box) return;
    const want = box.checked;
    box.disabled = true;
    this.socket.emit(want ? 'grant-badge' : 'revoke-badge', { userId, badgeId: Number(box.dataset.badgeId) }, (res) => {
      box.disabled = false;
      if (!res || !res.ok) {
        box.checked = !want;
        this._showToast(res?.error || t('badges.save_failed'), 'error');
        return;
      }
      this._badgeAdminLoadedAt = 0; // holder counts changed
      this._showToast(t(want ? 'badges.given' : 'badges.taken_back'), 'success');
    });
  });
},

};

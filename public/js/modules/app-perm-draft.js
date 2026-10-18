// Changes in the Permissions panel wait for Save (app-perm-matrix.js).
//
// Every box, role chip and the Auto-assign choice used to save the moment it
// was clicked. A slip went live at once: picking a moderator role as the
// automatic one hands it to everyone who joins a channel. Now a change is
// marked on screen and kept in a draft, and the footer's Save button sends
// it all; Discard, or closing and confirming, drops it. Adding and removing
// whole roles still happen at once, as both ask first.
//
// The draft holds only what differs from what the server last sent:
//   rolePerms  roleId -> Set of the permissions the role should have
//   autoRole   the role to make automatic, or null for no change
//   userRoles  userId -> Set of the role ids the person should hold
//   userPerms  userId -> Map permission -> on/off

export default {

_permDraft() {
  if (!this._permPanel.draft) this._permDraftReset();
  return this._permPanel.draft;
},

_permDraftReset() {
  this._permPanel.draft = { rolePerms: new Map(), autoRole: null, userRoles: new Map(), userPerms: new Map() };
},

// ── What the panel shows: the draft over what the server sent ──

_draftRolePerms(role) {
  return this._permDraft().rolePerms.get(role.id) || new Set(role.permissions || []);
},

_draftAutoRoleId() {
  const d = this._permDraft();
  if (d.autoRole !== null) return d.autoRole;
  return (this._permPanel.roles || []).find(r => r.auto_assign)?.id ?? null;
},

_draftUserRoleIds(user) {
  return this._permDraft().userRoles.get(user.id) || new Set(user.roleIds || []);
},

// On/off for one of someone's boxes, and whether that is a pending change.
_draftUserPerm(user, perm, base) {
  const own = this._permDraft().userPerms.get(user.id);
  return own && own.has(perm) ? { on: own.get(perm), pending: true } : { on: base, pending: false };
},

// ── Changing the draft ──

_draftToggleRolePerm(roleId, perm, on) {
  if (this._permSaving) { this._permDraftChanged(); return; }
  const role = (this._permPanel.roles || []).find(r => r.id === roleId);
  if (!role) return;
  const d = this._permDraft();
  const next = new Set(this._draftRolePerms(role));
  if (on) next.add(perm); else next.delete(perm);
  const base = new Set(role.permissions || []);
  const same = next.size === base.size && [...next].every(p => base.has(p));
  if (same) d.rolePerms.delete(roleId); else d.rolePerms.set(roleId, next);
  this._permDraftChanged();
},

_draftSetAutoRole(roleId) {
  if (this._permSaving) { this._permDraftChanged(); return; }
  const current = (this._permPanel.roles || []).find(r => r.auto_assign)?.id ?? null;
  this._permDraft().autoRole = roleId === current ? null : roleId;
  this._permDraftChanged();
},

_draftToggleUserRole(user, roleId) {
  if (this._permSaving) { this._permDraftChanged(); return; }
  const d = this._permDraft();
  const next = new Set(this._draftUserRoleIds(user));
  if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
  const base = new Set(user.roleIds || []);
  const same = next.size === base.size && [...next].every(id => base.has(id));
  if (same) d.userRoles.delete(user.id); else d.userRoles.set(user.id, next);
  this._permDraftChanged();
},

_draftSetUserPerm(user, perm, on, base) {
  if (this._permSaving) { this._permDraftChanged(); return; }
  const d = this._permDraft();
  const own = d.userPerms.get(user.id) || new Map();
  if (on === base) own.delete(perm); else own.set(perm, on);
  if (own.size) d.userPerms.set(user.id, own); else d.userPerms.delete(user.id);
  this._permDraftChanged();
},

// How many separate changes are waiting.
_permDraftCount() {
  const d = this._permDraft();
  let n = d.autoRole !== null ? 1 : 0;
  for (const role of this._permPanel.roles || []) {
    const next = d.rolePerms.get(role.id);
    if (!next) continue;
    const base = new Set(role.permissions || []);
    n += [...next].filter(p => !base.has(p)).length + [...base].filter(p => !next.has(p)).length;
  }
  for (const user of this._permPanel.users || []) {
    const next = d.userRoles.get(user.id);
    if (!next) continue;
    const base = new Set(user.roleIds || []);
    n += [...next].filter(id => !base.has(id)).length + [...base].filter(id => !next.has(id)).length;
  }
  for (const own of d.userPerms.values()) n += own.size;
  return n;
},

_permDraftChanged() {
  const n = this._permDraftCount();
  const save = document.getElementById('perm-save-btn');
  const discard = document.getElementById('perm-discard-btn');
  if (save) {
    save.disabled = n === 0 || !!this._permSaving;
    save.textContent = n ? t('settings.admin.perm_matrix.save_count', { count: n }) : t('settings.admin.perm_matrix.save');
  }
  if (discard) discard.hidden = n === 0;
  if (this._permPanel.view === 'users') this._renderPermUserDetail();
  else this._renderPermMatrix();
},

_discardPermDraft() {
  this._permDraftReset();
  this._permDraftChanged();
},

// Closing with changes waiting asks first. Returns whether it closed.
async _requestClosePermMatrix() {
  if (this._permCloseAsking) return false;
  if (this._permDraftCount() > 0) {
    this._permCloseAsking = true;
    let ok;
    try {
      ok = await this._showConfirmModal(t('settings.admin.perm_matrix.unsaved_title'), t('settings.admin.perm_matrix.unsaved_body'),
        { danger: true, confirmLabel: t('settings.admin.perm_matrix.discard') });
    } finally { this._permCloseAsking = false; }
    if (!ok) return false;
    this._permDraftReset();
  }
  this._closePermMatrix();
  return true;
},

// ── Saving: one request per change, in an order the server accepts ──
// Role permissions first (making a role automatic checks what it carries),
// then the automatic role, then who holds which role, then each person's own
// boxes.

_permAsk(event, payload) {
  return new Promise(resolve => this.socket.timeout(10000).emit(event, payload, (err, res) => {
    resolve(err ? { error: t('toasts.role_server_no_response') } : (res || {}));
  }));
},

async _savePermDraft() {
  if (this._permSaving) return;
  this._permSaving = true;
  const d = this._permDraft();
  const save = document.getElementById('perm-save-btn');
  if (save) save.disabled = true;
  const errors = [];
  const note = (res) => { if (res && res.error && !errors.includes(res.error)) errors.push(res.error); };

  for (const [roleId, perms] of d.rolePerms) {
    note(await this._permAsk('update-role', { roleId, permissions: [...perms] }));
  }
  if (d.autoRole !== null) note(await this._permAsk('update-role', { roleId: d.autoRole, autoAssign: true }));
  for (const [userId, next] of d.userRoles) {
    const user = (this._permPanel.users || []).find(u => u.id === userId);
    const base = new Set(user ? user.roleIds || [] : []);
    for (const roleId of next) if (!base.has(roleId)) note(await this._permAsk('assign-role', { userId, roleId }));
    for (const roleId of base) if (!next.has(roleId)) note(await this._permAsk('revoke-role', { userId, roleId }));
  }
  for (const [userId, own] of d.userPerms) {
    for (const [permission, allowed] of own) note(await this._permAsk('set-user-server-perm', { userId, permission, allowed }));
  }

  this._permSaving = false;
  this._permDraftReset();
  this._permDraftChanged();
  this._loadPermPanel();
  if (errors.length) this._showToast(errors.join(' · '), 'error');
  else this._showToast(t('settings.admin.perm_matrix.saved'), 'success');
},

};

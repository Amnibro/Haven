// Backups and restores ask the admin for their password again, and their
// two-factor code when they use one (src/adminReauth.js). A backup holds every
// account's password hash and a restore can rewrite any account, so a session
// someone else got hold of is not enough on its own.

export default {

// Resolves { password, code } or null if the admin backs out.
_askAdminReauth() {
  return new Promise((resolve) => {
    const sso = !!this.user?.isSso;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <h3 class="modal-title"></h3>
        <p class="settings-hint reauth-hint"></p>
        <div class="form-group reauth-pw-row">
          <input type="password" class="form-input reauth-pw" autocomplete="current-password">
        </div>
        <div class="form-group">
          <input type="text" class="form-input reauth-code" inputmode="numeric" maxlength="11" autocomplete="one-time-code">
        </div>
        <p class="reauth-error" style="color:var(--danger,#ed4245);min-height:1em;margin:0"></p>
        <div class="modal-actions">
          <button class="btn-sm reauth-cancel"></button>
          <button class="btn-sm btn-accent reauth-ok"></button>
        </div>
      </div>`;
    const q = (sel) => overlay.querySelector(sel);
    q('.modal-title').textContent = t('admin_reauth.title');
    q('.reauth-hint').textContent = t('admin_reauth.hint');
    q('.reauth-pw').placeholder = t('admin_reauth.password');
    q('.reauth-code').placeholder = t('admin_reauth.code');
    q('.reauth-cancel').textContent = t('modals.common.cancel');
    q('.reauth-ok').textContent = t('admin_reauth.continue');
    if (sso) q('.reauth-pw-row').style.display = 'none';
    const done = (value) => { overlay.remove(); resolve(value); };
    q('.reauth-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    const submit = () => {
      const password = q('.reauth-pw').value;
      const code = q('.reauth-code').value.trim();
      if (!sso && !password) { q('.reauth-error').textContent = t('admin_reauth.need_password'); return; }
      done({ password, code });
    };
    q('.reauth-ok').addEventListener('click', submit);
    overlay.querySelectorAll('input').forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    document.body.appendChild(overlay);
    (sso ? q('.reauth-code') : q('.reauth-pw')).focus();
  });
},

// A one-time, two-minute ticket for a backup download, or null.
async _adminDownloadTicket(body) {
  const reauth = await this._askAdminReauth();
  if (!reauth) return null;
  try {
    const res = await fetch('/api/admin/download-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
      body: JSON.stringify({ ...body, password: reauth.password, code: reauth.code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ticket) {
      this._showToast(data.error || t('admin_reauth.failed'), 'error');
      return null;
    }
    return data.ticket;
  } catch (err) {
    console.warn('[backup] download ticket request failed', err);
    this._showToast(t('admin_reauth.failed'), 'error');
    return null;
  }
},

};

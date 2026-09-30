export default {
  _setupServerTemplates() {
    const $ = (id) => document.getElementById(id);
    const box = $('template-preview'), applyBtn = $('template-apply-btn');
    if (!box || !applyBtn) return;
    const tk = (k, v) => t(`settings.admin.template.${k}`, v);
    const auth = () => ({ Authorization: `Bearer ${localStorage.getItem('haven_token') || ''}` });
    const opts = () => ({ mode: $('template-mode').value === 'replace' ? 'replace' : 'merge', posts: $('template-opt-posts').checked, webhooks: $('template-opt-webhooks').checked, joinMembers: $('template-opt-join').checked });
    const call = async (url, body) => {
      const res = await fetch(url, { method: 'POST', headers: { ...auth(), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { details: data.details || [] });
      return data;
    };
    let pending = null;
    const show = (html) => { box.style.display = html ? '' : 'none'; box.innerHTML = html; };
    const plan = async () => {
      applyBtn.disabled = true;
      try {
        const report = await call('/api/admin/template/plan', { id: pending.id, ...opts() });
        show(this._templateReportHtml(pending, report));
        applyBtn.disabled = false;
      } catch (err) { show(this._templateErrorHtml(err)); }
    };
    $('template-export-btn')?.addEventListener('click', async () => {
      try {
        const q = new URLSearchParams({ posts: $('template-export-posts').checked ? 'pinned' : 'none', assets: $('template-export-assets').checked ? '1' : '0' });
        const res = await fetch(`/api/admin/template/export?${q}`, { headers: auth() });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'haven.haven-template.json';
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name, style: 'display:none' });
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        this._showToast(tk('exported'), 'success');
      } catch (err) { this._showToast(`${tk('export_failed')}: ${err.message}`, 'error'); }
    });
    $('template-file')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      pending = null;
      applyBtn.disabled = true;
      if (!file) return show('');
      show(`<small class="settings-hint">${this._escapeHtml(tk('checking'))}</small>`);
      if (!(this.channels || []).some((c) => !c.is_dm)) $('template-mode').value = 'replace';
      try {
        const fd = new FormData();
        fd.append('template', file);
        pending = await call('/api/admin/template/upload', fd);
        await plan();
      } catch (err) { show(this._templateErrorHtml(err)); }
    });
    ['template-mode', 'template-opt-posts', 'template-opt-webhooks', 'template-opt-join'].forEach((id) => $(id)?.addEventListener('change', () => pending && plan()));
    applyBtn.addEventListener('click', async () => {
      if (!pending || !(await this._showConfirmModal(tk('title'), tk('confirm')))) return;
      applyBtn.disabled = true;
      try {
        const report = await call('/api/admin/template/apply', { id: pending.id, ...opts() });
        show(this._templateReportHtml(pending, report));
        this._showToast(tk('applied'), 'success');
        pending = null;
        $('template-file').value = '';
      } catch (err) {
        show(this._templateErrorHtml(err));
        this._showToast(`${tk('apply_failed')}: ${err.message}`, 'error');
      }
    });
  },
  _templateErrorHtml(err) {
    const esc = (s) => this._escapeHtml(String(s));
    return `<div class="template-report template-report-error"><b>${esc(t('settings.admin.template.invalid'))}</b> ${esc(err.message)}${(err.details || []).length ? `<ul>${err.details.slice(0, 20).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`;
  },
  _templateReportHtml(pending, r) {
    const esc = (s) => this._escapeHtml(String(s));
    const tk = (k, v) => t(`settings.admin.template.${k}`, v);
    const s = pending.summary;
    const row = (label, list) => (list && list.length ? `<div class="template-row"><span class="template-row-label">${esc(label)} (${list.length})</span> ${list.map(esc).join(', ')}</div>` : '');
    const group = (title, rows) => (rows.join('') ? `<div class="template-group"><b>${esc(title)}</b>${rows.join('')}</div>` : '');
    const body = [
      group(tk(r.dryRun ? 'will_create' : 'did_create'), [row(tk('channels'), r.created.channels), row(tk('roles'), r.created.roles), row(tk('webhooks'), r.created.webhooks), row(tk('files'), r.created.files)]),
      group(tk(r.dryRun ? 'will_update' : 'did_update'), [row(tk('channels'), r.updated.channels), row(tk('roles'), r.updated.roles), row(tk('settings'), r.updated.settings)]),
      group(tk('left_alone'), [row(tk('channels'), r.existing.channels), row(tk('roles'), r.existing.roles), row(tk('settings'), r.existing.settings)]),
      group(tk('kept'), [row(tk('channels'), r.extra.channels), row(tk('roles'), r.extra.roles)]),
    ].join('');
    const counts = r.counts.posts || r.counts.roleMenus || r.counts.domains ? `<div class="template-row">${esc(tk('counts', { posts: r.counts.posts, menus: r.counts.roleMenus, domains: r.counts.domains }))}</div>` : '';
    const notes = [...(pending.warnings || []), ...r.warnings];
    return `<div class="template-report">
      <div class="template-summary">${esc(tk('summary', { name: s.name || '?', channels: s.channels, roles: s.roles, posts: s.posts }))}</div>
      ${s.description ? `<div class="template-row">${esc(s.description)}</div>` : ''}
      ${body || counts ? body + counts : `<div class="template-row">${esc(tk('nothing'))}</div>`}
      ${notes.length ? `<div class="template-group"><b>${esc(tk('notes'))}</b><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  },
};

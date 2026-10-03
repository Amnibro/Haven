// Settings, Admin, Extension Updates: check plugins and themes for new
// releases and install or roll back one after a warning (#5578). Checks,
// downloads and file replacement all happen on the server.

export default {

// ── Plugin & theme updates ──────────────────────────────
// Bind once during app setup, but only check GitHub after an explicit click.
// File replacement and authorization remain server-side.
_setupExtensionUpdates() {
  const checkButton = document.getElementById('extension-update-check');
  if (!checkButton) return;
  if (this._extensionUpdatesBound) return;
  this._extensionUpdatesBound = true;

  const status = document.getElementById('extension-update-status');
  const results = document.getElementById('extension-update-results');
  const request = async (action, body = {}) => {
    const response = await fetch('/api/admin/extensions/' + action, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    // A proxy or size-limit error page is HTML, not JSON: show the generic
    // message for it instead of a parser error.
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error || t('settings.extension_updates.operation_failed'));
    return data;
  };

  const reviewUpdate = async (item, offer) => {
    // Keep the offer stable while confirmation is open and while applying it.
    // The extension confirmation escapes the publisher's release notes.
    const buttons = [checkButton, ...results.querySelectorAll('button')];
    buttons.forEach(button => button.disabled = true);
    try {
      const rollback = offer.action === 'rollback';
      const title = rollback
        ? t('settings.extension_updates.rollback_title')
        : t('settings.extension_updates.update_title');
      const warning = item.type === 'plugin'
        ? t('settings.extension_updates.plugin_warning')
        : t('settings.extension_updates.theme_warning');
      const message = [
        item.file, item.repo, `${item.version} → ${offer.version}`, '',
        rollback ? t('settings.extension_updates.rollback_notes') : (offer.notes || t('settings.extension_updates.no_notes')),
      ].join('\n');
      const confirmed = await this._showExtensionUpdateConfirm(
        title,
        message,
        warning,
        rollback ? t('settings.extension_updates.rollback') : t('settings.extension_updates.update'),
      );
      if (!confirmed) return;

      status.textContent = t('settings.extension_updates.installing');
      await request('apply', { token: offer.token });
      results.replaceChildren();
      status.textContent = t('settings.extension_updates.updated');
      this._showExtensionReloadNotice();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      buttons.forEach(button => button.disabled = false);
    }
  };

  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    results.replaceChildren();
    status.textContent = t('settings.extension_updates.checking');
    try {
      const data = await request('check');
      status.textContent = data.extensions.length
        ? t('settings.extension_updates.check_complete')
        : t('settings.extension_updates.no_sources');
      for (const item of data.extensions) {
        const card = document.createElement('div');
        card.className = 'plugin-card';
        const info = document.createElement('div');
        info.className = 'plugin-card-info';
        card.appendChild(info);
        const name = document.createElement('div');
        name.className = 'plugin-card-name';
        name.textContent = item.version ? `${item.file} · ${item.version}` : item.file;
        info.appendChild(name);

        const descriptions = item.repo ? [item.repo] : [];
        if (item.warning) descriptions.push(t('settings.extension_updates.installed_flagged', { reason: item.warning }));
        if (item.blockedUpdate) descriptions.push(t('settings.extension_updates.blocked_update', { reason: item.blockedUpdate }));
        if (item.error) descriptions.push(item.error);
        if (!item.error && !item.offers.some(offer => offer.action === 'install')) {
          descriptions.push(t('settings.extension_updates.no_updates'));
        }
        for (const text of descriptions) {
          const description = document.createElement('div');
          description.className = 'plugin-card-desc';
          description.textContent = text;
          info.appendChild(description);
        }
        const actions = document.createElement('div');
        actions.className = 'extension-update-actions';
        for (const offer of item.offers) {
          if (offer.releaseUrl) {
            const link = document.createElement('a');
            link.className = 'btn-sm';
            link.href = offer.releaseUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = t('settings.extension_updates.release_link');
            actions.appendChild(link);
          }
          const button = document.createElement('button');
          button.className = offer.action === 'rollback' ? 'btn-sm' : 'btn-sm btn-accent';
          button.textContent = offer.action === 'rollback'
            ? t('settings.extension_updates.review_rollback', { version: offer.version })
            : t('settings.extension_updates.review_update', { version: offer.version });
          button.addEventListener('click', () => reviewUpdate(item, offer));
          actions.appendChild(button);
        }
        if (actions.childElementCount) card.appendChild(actions);
        results.appendChild(card);
      }
    } catch (err) {
      status.textContent = err.message;
    } finally {
      checkButton.disabled = false;
    }
  });
},

// Extension installs need a stronger warning than Haven's generic confirmation
// dialog because downloaded plugins run with the current user's access.
_showExtensionUpdateConfirm(title, message, warning, confirmLabel) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '100002';
    overlay.innerHTML = `
      <div class="modal modal-confirm">
        <h3 style="margin-top:0">${this._escapeHtml(title)}</h3>
        <p class="muted-text" style="margin:0 0 12px;white-space:pre-line">${this._escapeHtml(message)}</p>
        <div class="extension-update-warning" role="alert">
          <strong>⚠️ ${this._escapeHtml(t('modals.common.warning'))}</strong>
          <p>${this._escapeHtml(warning)}</p>
          <div class="modal-actions">
            <button class="btn-sm" id="extension-update-cancel">${this._escapeHtml(t('modals.common.cancel'))}</button>
            <button class="btn-sm btn-accent" id="extension-update-confirm">${this._escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const confirm = overlay.querySelector('#extension-update-confirm');
    const cancel = overlay.querySelector('#extension-update-cancel');
    const close = value => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    // Enter is left to the focused button, so it never confirms while
    // Cancel is the one selected.
    const onKey = event => {
      if (event.key === 'Escape') close(false);
    };
    confirm.addEventListener('click', () => close(true));
    cancel.addEventListener('click', () => close(false));
    overlay.addEventListener('click', event => { if (event.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    // Start on Cancel: installing code should take a deliberate click.
    setTimeout(() => cancel.focus(), 0);
  });
},

_showExtensionReloadNotice() {
  // The applying admin receives both the HTTP response and socket event.
  // Show one toast per page session; running extensions change only on reload.
  if (this._extensionReloadNoticeShown) return;
  this._extensionReloadNoticeShown = true;
  this._showToast(t('settings.extension_updates.reload_notice'), 'info', {
    label: t('settings.extension_updates.reload'),
    onClick: () => window.location.reload(),
  }, 15000);
},

};

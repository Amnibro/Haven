const SETTINGS_PAGES = {
  user: [
    ['look', '🎨', 'settings.pages.look', 'Appearance', ['section-layout', 'section-toolbar-icons', 'section-role-display', 'section-reaction-size', 'section-banner-display', 'section-toggle-style']],
    ['chat', '💬', 'settings.pages.chat', 'Chat & media', ['section-chat-behavior', 'section-image-display', 'section-embed-size', 'section-soundboard-mode']],
    ['alerts', '🔔', 'settings.pages.alerts', 'Notifications', ['section-sounds', 'section-push', 'section-whats-new']],
    ['profile', '🎮', 'settings.pages.profile', 'Profile & activity', ['section-activity', 'section-score-badges']],
    ['security', '🔒', 'settings.pages.security', 'Account & security', ['section-password', 'section-e2e-passphrase', 'section-2fa', 'section-recovery', 'section-sessions', 'section-data-privacy', 'section-delete-account']],
    ['language', '🗣️', 'settings.pages.language', 'Language', ['section-language']],
    ['access', '♿', 'settings.pages.access', 'Accessibility', ['section-zoom']],
    ['advanced', '🧩', 'settings.pages.advanced', 'Plugins & advanced', ['section-plugins', 'section-desktop-shortcuts', 'section-desktop-app', 'section-debug']]
  ],
  admin: [
    ['server', '🏠', 'settings.pages.server', 'Server', ['section-branding', 'section-custom-tos', 'section-presence', 'section-update', 'section-extension-updates']],
    ['people', '👥', 'settings.pages.people', 'People & roles', ['section-members', 'section-roles', 'section-badges', 'section-guests', 'section-whitelist', 'section-invite']],
    ['safety', '🛡️', 'settings.pages.safety', 'Safety', ['section-moderation', 'section-automod', 'section-security', 'section-modmode', 'section-audit-log']],
    ['content', '😎', 'settings.pages.content', 'Content', ['section-emojis', 'section-stickers', 'section-sounds-admin', 'section-tags-admin', 'section-uploads', 'section-cleanup']],
    ['network', '📡', 'settings.pages.network', 'Network & scale', ['section-connectivity', 'section-large-server', 'section-tunnel']],
    ['tools', '🤖', 'settings.pages.tools', 'Bots & data', ['section-bots', 'section-ferry', 'section-import', 'section-backup', 'section-template']]
  ]
};
export default {
_setupSettingsPages() {
  const nav = document.getElementById('settings-nav'), modal = document.getElementById('settings-modal');
  if (!nav || !modal || this._spReady) return;
  this._spReady = true;
  this._spPage = { user: 'look', admin: 'server' };
  const tr = (k, f) => { const s = typeof t === 'function' ? t(k) : ''; return s && s !== k ? s : f; };
  const sides = { user: { nav: nav.querySelector('.settings-nav-user'), body: document.getElementById('settings-body-user'), sel: '.settings-section' }, admin: { nav: nav.querySelector('.settings-nav-admin-group'), body: document.getElementById('settings-body-admin'), sel: '#admin-mod-panel > .admin-settings[id]' } };
  this._spSides = sides;
  Object.entries(sides).forEach(([side, s]) => {
    if (!s.nav || !s.body) return;
    const known = new Set(SETTINGS_PAGES[side].flatMap(p => p[4])), extra = [...s.body.querySelectorAll(s.sel)].map(x => x.id).filter(id => id && id !== 'admin-mod-panel' && !known.has(id));
    s.pages = [...SETTINGS_PAGES[side], ...(extra.length ? [['more', '➕', 'settings.pages.more', 'More', extra]] : [])];
    const list = document.createElement('div');
    list.className = 'sp-list';
    s.pages.forEach(([id, icon, key, label]) => {
      const item = Object.assign(document.createElement('div'), { className: 'sp-cat', tabIndex: 0 });
      item.dataset.sp = id;
      item.setAttribute('role', 'button');
      item.append(Object.assign(document.createElement('span'), { className: 'sp-icon', textContent: icon }), Object.assign(document.createElement('span'), { textContent: tr(key, label) }));
      item.addEventListener('click', () => this._showSettingsPage(side, id));
      item.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), this._showSettingsPage(side, id)));
      list.append(item);
    });
    s.nav.prepend(list);
    s.list = list;
    s.body.classList.add('sp-body');
  });
  nav.classList.add('sp-nav');
  document.addEventListener('click', (e) => {
    const item = !this._spBusy && e.target.closest?.('#settings-nav .settings-nav-item[data-target]');
    if (!item) return;
    const side = item.closest('.settings-nav-admin-group') ? 'admin' : 'user', page = sides[side].pages?.find(p => p[4].includes(item.dataset.target));
    page && page[0] !== this._spPage[side] && this._showSettingsPage(side, page[0], item.dataset.target);
  }, true);
  ['input', 'keyup', 'search'].forEach(ev => modal.addEventListener(ev, (e) => e.target?.id === 'settings-search' && modal.classList.toggle('sp-search', !!e.target.value.trim())));
  document.querySelectorAll('#settings-tab-bar .settings-tab').forEach(tab => tab.addEventListener('click', () => setTimeout(() => this._showSettingsPage(tab.dataset.tab === 'admin' ? 'admin' : 'user'), 0)));
  document.getElementById('open-settings-btn')?.addEventListener('click', () => setTimeout(() => { this._showSettingsPage('user'); this._showSettingsPage('admin'); }, 0));
  this._showSettingsPage('user');
},
_spAvailable(side, id) {
  const s = this._spSides[side], navItem = s.nav.querySelector(`.settings-nav-item[data-target="${id}"]`), sec = document.getElementById(id);
  return !!sec && (!navItem || navItem.style.display !== 'none');
},
_showSettingsPage(side, id, skip) {
  const s = this._spSides?.[side];
  if (!s?.pages) return;
  const usable = s.pages.filter(p => p[4].some(sid => this._spAvailable(side, sid)));
  const page = usable.find(p => p[0] === (id || this._spPage[side])) || usable[0];
  if (!page) return;
  this._spPage[side] = page[0];
  s.list.querySelectorAll('.sp-cat').forEach(c => { const on = c.dataset.sp === page[0]; c.classList.toggle('active', on); c.setAttribute('aria-current', on ? 'page' : 'false'); c.style.display = usable.some(p => p[0] === c.dataset.sp) ? '' : 'none'; on && s.list.scrollWidth > s.list.clientWidth && c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  s.body.querySelectorAll(s.sel).forEach(sec => sec.id !== 'admin-mod-panel' && sec.classList.toggle('sp-off', !page[4].includes(sec.id)));
  this._spBusy = true;
  page[4].filter(sid => sid !== skip && this._spAvailable(side, sid)).forEach(sid => {
    const sec = document.getElementById(sid), navItem = s.nav.querySelector(`.settings-nav-item[data-target="${sid}"]`);
    if (!navItem) return;
    sec.scrollIntoView = () => {};
    try { navItem.click(); } finally { delete sec.scrollIntoView; }
  });
  this._spBusy = false;
  skip || (s.body.scrollTop = 0);
},
};

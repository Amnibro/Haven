// The theme picker (the palette button at the bottom of the sidebar): a
// searchable gallery of preview cards in sections. Members see Haven's own
// themes and the ones the admin published; admins also see the themes nobody
// has published yet and can publish or take back any of them from its card.
// Which themes go where, the search and the arrow-key moves live in
// public/js/theme-gallery.js; this file draws the cards and wires them up.
// Picking a theme still goes through theme.js (built-in themes) and
// plugin-loader.js (theme files), which save it to the account.

const COLLAPSED_KEY = 'haven_theme_picker_collapsed';

function readCollapsed() {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set(); // storage blocked or unreadable: every section starts open
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// The mock window drawn on every card: a side panel, an accent bar and two
// lines of text, in the theme's own colours.
function previewNode(icon) {
  const preview = el('span', 'tp-preview');
  preview.setAttribute('aria-hidden', 'true');
  const main = el('span', 'tp-p-main');
  main.append(el('span', 'tp-p-accent'), el('span', 'tp-p-line'), el('span', 'tp-p-line tp-p-short'));
  preview.append(el('span', 'tp-p-side'), main);
  if (icon) preview.append(icon);
  return preview;
}

export default {

_setupThemePicker() {
  const root = document.getElementById('theme-selector');
  const sections = document.getElementById('theme-gallery-sections');
  if (!root || !sections || !window.HavenThemeGallery || root.dataset.galleryBound) return;
  root.dataset.galleryBound = '1';

  this._themeCards = new Map();
  this._themeCollapsed = readCollapsed();
  this._themeFocusId = null;

  // Haven's own themes are the buttons already in the page, which theme.js
  // has wired up; they are moved into the gallery and dressed as cards.
  this._themePickerBuiltins = [];
  root.querySelectorAll('.theme-btn[data-theme]').forEach(btn => {
    const id = btn.dataset.theme;
    if (!id || id.startsWith('file:')) return;
    const title = btn.getAttribute('title') || id;
    const extra = title.match(/\s*\(([^)]+)\)\s*$/);
    const name = extra ? title.slice(0, extra.index) : title;
    this._themePickerBuiltins.push({ id, name, keywords: extra ? extra[1] : '' });
    this._dressThemeCard(btn, name, '');
    const wrap = el('div', 'tp-card-wrap');
    wrap.append(btn);
    this._themeCards.set(id, wrap);
  });
  root.querySelector('.tp-builtin-source')?.remove();

  // Publish switches and the themes only admins can see stay out of the way
  // until an admin asks for them.
  document.getElementById('theme-publish-mode')?.addEventListener('click', (e) => {
    const on = !root.classList.contains('tp-publishing');
    root.classList.toggle('tp-publishing', on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });

  const search = document.getElementById('theme-search');
  search?.addEventListener('input', () => {
    this._renderThemePicker();
    clearTimeout(this._themeAnnounceTimer);
    this._themeAnnounceTimer = setTimeout(() => this._announceThemeResults(), 400);
  });
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && search.value.trim())) {
      e.preventDefault();
      this._focusThemeCard(this._themeFocusTarget());
    }
  });

  sections.addEventListener('keydown', (e) => this._onThemeGalleryKey(e));
  sections.addEventListener('focusin', (e) => {
    const card = e.target.closest?.('.tp-card');
    if (card) this._setThemeFocus(card.dataset.theme);
  });

  // Built-in buttons are switched by theme.js, which only toggles .active.
  const observer = new MutationObserver(() => this._syncThemePressed());
  observer.observe(sections, { subtree: true, attributes: true, attributeFilter: ['class'] });

  const schedule = () => {
    if (this._themeRenderQueued) return;
    this._themeRenderQueued = true;
    requestAnimationFrame(() => { this._themeRenderQueued = false; this._renderThemePicker(); });
  };
  document.addEventListener('haven:themes-changed', schedule);

  document.getElementById('theme-popup-toggle')?.addEventListener('click', () => {
    const popup = document.getElementById('theme-popup');
    if (!popup || popup.style.display === 'none') return;
    this._renderThemePicker();
    // A phone would open its keyboard, so only a mouse and keyboard user
    // lands in the search box.
    if (window.matchMedia?.('(pointer: fine)').matches) search?.focus({ preventScroll: true });
  });

  this.socket?.on('server-setting-changed', (data) => {
    if (data?.key !== 'published_themes') return;
    this._onPublishedThemesChanged(data.value);
  });

  // The server only saves a theme file a member may use (see set-preference).
  this.socket?.on('preference-refused', (data) => {
    if (data?.key === 'theme') window.HavenPluginLoader?.onThemeRefused?.(data.value);
  });

  // Whether unpublished files show depends on Manage Server, which can arrive
  // or change after the theme list did. The app's own handlers update the
  // permissions first, so the redraw waits for them.
  const redrawForPermissions = () => setTimeout(() => window.HavenPluginLoader?.renderPluginUI?.(), 0);
  this.socket?.on('session-info', redrawForPermissions);
  this.socket?.on('roles-updated', redrawForPermissions);

  this._renderThemePicker();
},

// Whether this viewer can publish themes: the same check the server makes.
_canPublishThemes() {
  if (!this.user) return false;
  return !!(this.user.isAdmin || this._hasPerm?.('manage_server'));
},

_activeThemeId() {
  try { return localStorage.getItem('haven_theme') || 'haven'; } catch { return 'haven'; } // storage blocked: the page shows Haven
},

_themeRecords() {
  const loader = window.HavenPluginLoader;
  if (!loader?.loadedThemes) return [];
  return [...loader.loadedThemes.entries()].map(([file, record]) => ({
    ...record.meta,
    file,
    compatible: record.compatible,
    enabled: record.enabled,
  }));
},

// Turn a theme button into a card: preview, name and author.
_dressThemeCard(btn, name, author) {
  btn.type = 'button';
  btn.classList.add('tp-card');
  btn.removeAttribute('title');
  const icon = btn.querySelector('.theme-icon');
  btn.replaceChildren(previewNode(icon));
  const label = el('span', 'tp-label');
  label.append(el('span', 'tp-name', name));
  if (author) label.append(el('span', 'tp-author', author));
  btn.append(label, el('span', 'tp-check', '✓'));
  btn.querySelector('.tp-check').setAttribute('aria-hidden', 'true');
  btn.setAttribute('aria-label', author ? t('app.theme.picker.card_by', { name, author }) : name);
},

_themeFileCard(entry) {
  let wrap = this._themeCards.get(entry.id);
  if (!wrap) {
    wrap = el('div', 'tp-card-wrap');
    const btn = el('button', 'theme-btn');
    btn.dataset.theme = entry.id;
    btn.dataset.customTheme = '1';
    btn.addEventListener('click', () => window.HavenPluginLoader?.selectFileTheme?.(entry.file));
    wrap.append(btn);
    this._themeCards.set(entry.id, wrap);
  }
  const btn = wrap.querySelector('.tp-card, .theme-btn');
  const icon = el('span', 'theme-icon', entry.icon || '🎨');
  btn.replaceChildren(icon);
  this._dressThemeCard(btn, entry.name, entry.author);
  if (entry.description) btn.title = entry.description;
  btn.classList.toggle('tp-overlay', entry.overlay);
  const colors = window.HavenThemeGallery.cardColors(entry.swatch, window.HavenThemeCompat?.colorSchemeFor);
  for (const [key, prop] of [['bg', '--tp-sw-bg'], ['panel', '--tp-sw-panel'], ['accent', '--tp-sw-accent'], ['text', '--tp-sw-text']]) {
    if (colors[key]) btn.style.setProperty(prop, colors[key]);
    else btn.style.removeProperty(prop);
  }
  btn.disabled = !!window.HavenPluginLoader?.suppressed;
  return wrap;
},

// The admin's publish switch under a theme file's card, the same switch as
// Settings, Plugins & Themes, with a word saying what it does.
_themePublishSwitch(wrap, entry) {
  let row = wrap.querySelector('.tp-publish-row');
  wrap.classList.toggle('tp-admin', this._canPublishThemes());
  if (!this._canPublishThemes()) { row?.remove(); return; }
  if (!row) {
    row = el('label', 'tp-publish-row');
    const toggle = el('span', 'plugin-toggle tp-publish');
    const input = el('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => this._setThemePublished(input.dataset.file, input.checked));
    toggle.append(input, el('span', 'plugin-toggle-slider'));
    row.append(toggle, el('span', 'tp-publish-text'));
    wrap.append(row);
  }
  const input = row.querySelector('input');
  input.dataset.file = entry.file;
  input.checked = entry.published;
  input.disabled = this._themePublishPending === entry.file;
  input.setAttribute('aria-label', t('app.theme.picker.publish_label', { name: entry.name }));
  row.querySelector('.tp-publish-text').textContent = entry.published ? t('app.theme.picker.published') : t('app.theme.picker.publish');
  row.title = entry.published ? t('app.theme.picker.published_hint') : t('app.theme.picker.unpublished_hint');
},

_themeSectionTitle(section) {
  if (section.name) return section.name;
  if (section.key === 'community') return t('app.theme.picker.section_community');
  if (section.key === 'seasonal') return t('app.theme.seasonal');
  if (section.key === 'available') return t('app.theme.picker.section_available');
  return t('app.theme.picker.section_builtin');
},

_renderThemePicker() {
  const container = document.getElementById('theme-gallery-sections');
  if (!container || !this._themeCards || !window.HavenThemeGallery) return;
  const query = document.getElementById('theme-search')?.value || '';
  const searching = !!query.trim();
  const activeTheme = this._activeThemeId();
  const sections = window.HavenThemeGallery.buildSections({
    builtins: this._themePickerBuiltins,
    themes: this._themeRecords(),
    isAdmin: this._canPublishThemes(),
    activeTheme,
    query,
  });

  const publishMode = document.getElementById('theme-publish-mode');
  if (publishMode) publishMode.hidden = !this._canPublishThemes();

  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const fragment = document.createDocumentFragment();
  sections.forEach((section, index) => {
    const block = el('section', 'tp-section');
    block.dataset.section = section.key;
    block.setAttribute('role', 'group');
    const headId = `tp-head-${index}`;
    const gridId = `tp-grid-${index}`;
    block.setAttribute('aria-labelledby', headId);

    const collapsed = !searching && this._themeCollapsed.has(section.key);
    const head = el('h6', 'tp-section-head');
    const toggle = el('button', 'tp-section-toggle');
    toggle.type = 'button';
    toggle.id = headId;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', gridId);
    toggle.append(el('span', 'tp-section-name', this._themeSectionTitle(section)),
      el('span', 'tp-count', searching ? `${section.entries.length}/${section.total}` : String(section.total)));
    const chevron = el('span', 'tp-chevron', '▾');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(chevron);
    toggle.addEventListener('click', () => this._toggleThemeSection(section.key));
    head.append(toggle);
    block.append(head);

    if (section.key === 'available' && !collapsed) {
      block.append(el('p', 'tp-hint', t('app.theme.picker.available_hint')));
    }

    const grid = el('div', 'tp-grid');
    grid.id = gridId;
    grid.hidden = collapsed;
    for (const entry of section.entries) {
      const wrap = entry.kind === 'file' ? this._themeFileCard(entry) : this._themeCards.get(entry.id);
      if (!wrap) continue;
      if (entry.kind === 'file') this._themePublishSwitch(wrap, entry);
      wrap.dataset.overlay = entry.kind === 'file' && entry.overlay ? '1' : '';
      wrap.dataset.pressed = window.HavenThemeGallery.isPressed(entry, activeTheme) ? '1' : '';
      grid.append(wrap);
    }
    block.append(grid);
    fragment.append(block);
  });
  container.replaceChildren(fragment);

  const empty = document.getElementById('theme-gallery-empty');
  if (empty) empty.hidden = sections.length > 0;
  this._syncThemePressed();
  if (focused?.isConnected) focused.focus({ preventScroll: true });
},

// aria-pressed follows the selected theme. Theme files that only add CSS
// on top are pressed while they are on.
_syncThemePressed() {
  const container = document.getElementById('theme-gallery-sections');
  if (!container) return;
  container.querySelectorAll('.tp-card-wrap').forEach(wrap => {
    const card = wrap.querySelector('.tp-card');
    if (!card) return;
    const pressed = wrap.dataset.overlay === '1' ? wrap.dataset.pressed === '1' : card.classList.contains('active');
    if (card.getAttribute('aria-pressed') !== String(pressed)) card.setAttribute('aria-pressed', String(pressed));
    card.classList.toggle('tp-on', pressed);
  });
  this._updateThemeTabStops();
},

_visibleThemeCards() {
  const container = document.getElementById('theme-gallery-sections');
  return container ? [...container.querySelectorAll('.tp-grid:not([hidden]) .tp-card')] : [];
},

// The card Tab lands on: the one last focused, else the chosen theme, else the first.
_themeFocusTarget() {
  const cards = this._visibleThemeCards();
  return cards.find(card => card.dataset.theme === this._themeFocusId)
    || cards.find(card => card.getAttribute('aria-pressed') === 'true')
    || cards[0] || null;
},

// One card (and its publish switch) in the Tab order at a time; the arrow
// keys move between cards.
_updateThemeTabStops() {
  const container = document.getElementById('theme-gallery-sections');
  if (!container) return;
  const target = this._themeFocusTarget();
  container.querySelectorAll('.tp-card-wrap').forEach(wrap => {
    const current = !!target && wrap.contains(target);
    wrap.querySelector('.tp-card')?.setAttribute('tabindex', current ? '0' : '-1');
    wrap.querySelector('.tp-publish input')?.setAttribute('tabindex', current ? '0' : '-1');
  });
},

_setThemeFocus(id) {
  if (this._themeFocusId === id) return;
  this._themeFocusId = id;
  this._updateThemeTabStops();
},

_focusThemeCard(card) {
  if (!card) return;
  this._setThemeFocus(card.dataset.theme);
  card.focus();
  card.scrollIntoView({ block: 'nearest' });
},

_onThemeGalleryKey(e) {
  const card = e.target.closest?.('.tp-card');
  if (!card || e.altKey || e.ctrlKey || e.metaKey) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const cards = this._visibleThemeCards();
    const boxes = cards.map(c => c.getBoundingClientRect());
    const rtl = getComputedStyle(card).direction === 'rtl';
    const key = rtl && e.key === 'ArrowLeft' ? 'ArrowRight' : rtl && e.key === 'ArrowRight' ? 'ArrowLeft' : e.key;
    const next = window.HavenThemeGallery.moveIndex(boxes, cards.indexOf(card), key);
    if (next >= 0) { e.preventDefault(); this._focusThemeCard(cards[next]); }
    return;
  }
  // Typing a letter on a card starts a search.
  if (e.key.length === 1 && e.key !== ' ') {
    const search = document.getElementById('theme-search');
    if (!search) return;
    e.preventDefault();
    search.focus();
    search.value += e.key;
    search.dispatchEvent(new Event('input'));
  }
},

_toggleThemeSection(key) {
  if (this._themeCollapsed.has(key)) this._themeCollapsed.delete(key);
  else this._themeCollapsed.add(key);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this._themeCollapsed]));
  } catch { /* storage blocked: the section stays as it is for this visit only */ }
  this._renderThemePicker();
  document.querySelector(`#theme-gallery-sections .tp-section[data-section="${CSS.escape(key)}"] .tp-section-toggle`)?.focus();
},

_announceThemeResults() {
  const status = document.getElementById('theme-gallery-status');
  if (!status) return;
  const count = this._visibleThemeCards().length;
  const query = document.getElementById('theme-search')?.value.trim();
  status.textContent = !query ? '' : count
    ? t('app.theme.picker.results', { count })
    : t('app.theme.picker.no_match');
},

// The admin's switch on a card. The server checks the permission again and
// tells every client, which redraws its picker from the new list.
_setThemePublished(file, publish) {
  if (!file || !this._canPublishThemes() || !this.socket) return;
  const current = window.HavenThemeGallery.parsePublished(this.serverSettings?.published_themes);
  const next = window.HavenThemeGallery.nextPublishedList(current, file, publish);
  this._themePublishPending = file;
  this._themePublishWanted = publish;
  clearTimeout(this._themePublishTimer);
  // No answer means the server refused (it says why in its own message).
  this._themePublishTimer = setTimeout(() => {
    this._themePublishPending = null;
    this._renderThemePicker();
  }, 5000);
  this.socket.emit('update-server-setting', { key: 'published_themes', value: JSON.stringify(next) });
  this._renderThemePicker();
},

_onPublishedThemesChanged(value) {
  if (this.serverSettings) this.serverSettings.published_themes = value;
  // Keep the admin form's starting point in step, so saving Settings later
  // does not put back the list from before this change.
  if (this._adminSnapshot) this._adminSnapshot.published_themes = value;
  if (document.getElementById('admin-theme-list')?.dataset.loaded === '1') this._renderAdminThemeList?.();

  const file = this._themePublishPending;
  if (file) {
    const published = window.HavenThemeGallery.parsePublished(value).includes(file);
    if (published === this._themePublishWanted) {
      clearTimeout(this._themePublishTimer);
      this._themePublishPending = null;
      const name = window.HavenPluginLoader?.loadedThemes?.get(file)?.meta?.name || file;
      this._showToast?.(t(published ? 'app.theme.picker.published_toast' : 'app.theme.picker.unpublished_toast', { name }), 'success');
    }
  }
  // The loader re-reads the theme list, so publishing changes which themes
  // are full themes and which only add CSS, the same as after a reload.
  window.HavenPluginLoader?.refresh?.();
},

};

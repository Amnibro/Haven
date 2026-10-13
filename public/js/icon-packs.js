/**
 * Haven: interface icon packs.
 *
 * Settings > Appearance > Icons picks how the interface's affordance icons are
 * drawn. The value lives in localStorage `haven-toolbar-icons` (member-default
 * key `interface_icons`), as it did before packs existed:
 *
 *   mono    emoji across the interface, monochrome SVGs in the message toolbars
 *           (the default)
 *   emoji   emoji everywhere, the toolbars included ('color' is an old name)
 *   glyphs  Font Awesome Free Solid, the glyphs the Haven Glyphs plugin drew
 *   line    Lucide outline icons
 *   native  Material Symbols Outlined
 *
 * The three font packs come from one registry shared with the Android and iOS
 * apps (icon-packs-data.js, generated). Every icon has a semantic id, the
 * emoji that stand for it in the markup, and one character, U+E000 + its
 * index, which is the same in all three fonts. Switching between font packs
 * only changes the font family on <html>; nothing is redrawn.
 *
 * Swapping works like the Haven Glyphs plugin it grew out of (thanks to
 * bernardokcosta): a sweep of the page, then a MutationObserver, turns an
 * affordance emoji into <i class="haven-icon">, but only inside interface
 * hosts (buttons, headings, settings rows, labelled badges) and never inside
 * user content, reactions, pickers or form fields. Going back to an emoji
 * pack puts the original emoji back.
 *
 * When nothing is saved, the current theme may suggest a pack (the registry's
 * `themes`), so a terminal-green theme does not have to fight color emoji.
 * A saved choice, the member's own or a server's member default, always wins.
 *
 * Works in the browser (window.HavenIcons) and in Node for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.HavenIcons = factory(root.HAVEN_ICON_DATA, root);
}(typeof self !== 'undefined' ? self : this, function (data, win) {
  'use strict';

  var STORAGE_KEY = 'haven-toolbar-icons';
  var MODES = ['mono', 'emoji', 'glyphs', 'line', 'native'];
  var FONT_PACKS = ['glyphs', 'line', 'native'];
  var DEFAULT_MODE = 'mono';
  data = data || { icons: {}, themes: {} };

  // emoji alias -> icon id, longest alias first so a sequence such as
  // "👁️‍🗨️" wins over its leading "👁".
  var ALIAS = {};
  var IDS = Object.keys(data.icons || {});
  IDS.forEach(function (id) {
    (data.icons[id].emoji || []).forEach(function (e) { ALIAS[e] = id; });
  });
  var KEYS = Object.keys(ALIAS).sort(function (a, b) { return b.length - a.length; });

  function normalize(value) {
    if (value === 'color') return 'emoji';
    return MODES.indexOf(value) >= 0 ? value : null;
  }

  // The pack to show: a saved choice, else the theme's suggestion, else mono.
  function resolve(saved, themeId) {
    var chosen = normalize(saved);
    if (chosen) return chosen;
    var suggested = normalize((data.themes || {})[String(themeId || '').toLowerCase()]);
    return suggested || DEFAULT_MODE;
  }

  function isFontPack(mode) { return FONT_PACKS.indexOf(mode) >= 0; }

  function iconIdFor(emoji) {
    if (ALIAS[emoji]) return ALIAS[emoji];
    var bare = emoji.replace(/️$/, '');
    return ALIAS[bare] || ALIAS[bare + '️'] || null;
  }

  function glyph(id) {
    var icon = data.icons && data.icons[id];
    return icon ? String.fromCharCode(icon.cp) : '';
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    MODES: MODES.slice(),
    FONT_PACKS: FONT_PACKS.slice(),
    DEFAULT_MODE: DEFAULT_MODE,
    data: data,
    aliases: KEYS,
    normalize: normalize,
    resolve: resolve,
    isFontPack: isFontPack,
    iconIdFor: iconIdFor,
    glyph: glyph
  };
  if (!win || !win.document) return api;

  // ── Browser ──────────────────────────────────────────────

  var doc = win.document;

  // Interface hosts the sweep may draw into. Inherited from Haven Glyphs.
  var EXPLICIT_SELECTOR = [
    '[data-haven-icon]',
    '.channel-hash', '.channel-collapse-arrow', '.channel-indicators',
    '.ch-disabled-badge', '.sub-panel-toggle-label', '.title-emoji',
    '.voice-settings-section-label', '.voice-settings-label',
    '.voice-indicator-icon', '.voice-stream-badge', '.voice-status-icon',
    '.voice-user-menu-label', '.voice-user-menu-action',
    '.user-action-btn', '.profile-popup-action-btn',
    '.pinned-tag', '.archived-tag', '.e2e-tag', '.ferry-badge',
    '.forum-tag-nsfw', '.forum-tag-protected', '.forum-tag-pinned',
    '.forum-topic-replies', '.forum-view-btn', '.forum-lock-layout',
    '.forum-new-post', '.forum-topic-edit', '.thread-panel-icon',
    '.tb-icon-emoji', '.thread-preview-arrow', '.profile-activity-verb',
    '.connection-help', '.media-grid-jump', '.media-list-jump',
    '.voice-icon', '.cvu-mic', '.cvu-deafen', '.rgb-slider-label',
    '.hidden-channels-bar > span:first-child', '.temp-channel-create-btn > span:first-child',
    '.import-server-icon-placeholder', '.audit-icon',
    '.pins-pip-icon', '.media-grid-play', '.media-list-icon',
    '.file-icon', '.file-download-arrow', '.manage-server-visit',
    '.manage-server-edit', '.manage-server-delete', '.status-bar-toggle-tab',
    '.status-url-toggle', '.sb-sidebar-header', '.sb-toggle-mark',
    '.sb-toggle-arrow', '.upload-icon-clippy', '.btn-burn',
    '.desktop-app-icon', '.android-beta-icon', '.burn-pending-label',
    '.burn-reveal-btn', '.burn-countdown-pill', '.burn-complete-label',
    '.risky-download-icon', '.transfer-admin-warning-icon', '.dm-safety-icon',
    '.rac-channel-icon', '.rac-card-locked', '.badge-scope', '.aml-member-storage',
    '.settings-nav-item', '.settings-group-label',
    '#section-score-badges > .settings-hint', '#totp-manage-area > .settings-hint:first-child',
    '.role-tpl-emoji', '.connection-icon', '.stream-size-label',
    '[data-i18n-title="modals.game_overlay.volume_label"]',
    '#manage-servers-btn .server-icon-text', '#sync-servers-btn .server-icon-text',
    '#webcam-label', '#screen-share-label',
    '.voice-bar-icon', '.music-pip-label-icon', '.music-pip-vol-icon',
    '.stream-audio-badge', '.stream-no-audio-badge', '.viewer-eye',
    '.music-search-picker-thumb', '.organize-tag-icon', '.thread-mention-badge',
    '.import-channel-type-icon', '.connectivity-test-icon',
    '.webhook-avatar-icon', '.webhook-status-icon',
    '.wizard-check', '.file-type-icon'
  ].join(',');

  var HOST_SELECTOR = [
    EXPLICIT_SELECTOR,
    '[data-i18n]',
    'button:not(.theme-btn):not(.effect-btn):not(.gif-tab):not(.soundboard-btn):not(.role-tpl-card):not(.forum-tag-chip):not(.activity-card):not(.connection-card)',
    '[role="button"]:not(.theme-btn):not(.effect-btn):not(.gif-tab):not(.soundboard-btn):not(.role-tpl-card):not(.forum-tag-chip)',
    'label[data-haven-icon], summary[data-haven-icon]',
    'h1, h2, h3, h4, h5, [role="heading"]'
  ].join(',');

  // Never drawn into: user content, reactions, pickers and form fields.
  var EXCLUSION_SELECTOR = [
    'input, textarea, select, option, optgroup, code, pre, kbd, samp, script, style',
    '[contenteditable], .haven-icon',
    '[data-haven-region="composer"], [data-haven-region="thread-panel"]',
    '[data-haven-region="soundboard"], [data-haven-region="pinned-messages"]',
    '[data-haven-region="search-results"]',
    '#emoji-picker, .emoji-picker, #gif-picker, #format-picker, #emoji-modal, #sticker-modal',
    '.message-content, .message-author, .message-username, .message-reactions',
    '.pinned-item-content, .search-result, .search-result-content',
    '.poll-widget, .poll-options, .role-menu-widget, .role-tpl-card',
    '.reaction, .reaction-chip, .reaction-badge, .emoji-only-msg',
    '.soundboard-btn, .soundboard-name, .sb-name, .forum-tag-chip',
    '.theme-icon, .activity-card, .activity-item, .connection-card, .provider-card',
    '.channel-name, .sub-panel-tile-name, .profile-status-text, .profile-bio',
    '.profile-popup-nickname, .user-status-text, .server-icon-text',
    '.server-name, .server-label, .user-name, .username, .display-name',
    '.activity-name, .activity-title, .connection-name, .connection-label',
    '.role-name, .role-label, .tag-name, .topic-title, .thread-topic-title',
    '.thread-msg-content, .thread-msg-author, .thread-list-author, .thread-list-preview',
    '.reply-preview',
    '.forum-topic-title, .forum-topic-meta, .file-name, .file-info, .role-preview-item',
    '.mobile-server-item, .server-item, .server-button',
    '[data-user-content]'
  ].join(',');

  var DEAFEN_SELECTOR = '#voice-deafen-btn, #voice-deafen-btn-header';

  var mode = DEFAULT_MODE;
  var observer = null;
  var busy = false;

  function readSaved() {
    try { return win.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } // storage blocked: nothing saved
  }

  function themeId() {
    return doc.documentElement.getAttribute('data-theme') || '';
  }

  function hostOf(element) {
    if (!element || !element.closest) return null;
    var direct = element.closest(HOST_SELECTOR);
    if (direct) return direct;
    // Static labels put the icon in a span right before a translated child,
    // such as "🔒 <span data-i18n>Private</span>". Climbing farther could reach
    // a broad ancestor that also holds user content.
    if (element.tagName === 'SPAN' && Array.prototype.some.call(element.children, function (child) {
      return child.hasAttribute('data-i18n') || child.hasAttribute('data-i18n-html');
    })) return element;
    return null;
  }

  function excluded(element, host) {
    if (host && host.matches && host.matches(EXPLICIT_SELECTOR)) return false;
    return !!element.closest(EXCLUSION_SELECTOR);
  }

  // Deafen buttons draw their own red slash while active; keep the plain
  // speaker there so the control does not show two slashes.
  function iconFor(emoji, host) {
    if (/^🔇/.test(emoji) && host && host.matches && host.matches(DEAFEN_SELECTOR)) return 'speaker';
    return iconIdFor(emoji);
  }

  function makeIcon(id, emoji) {
    var el = doc.createElement('i');
    el.className = 'haven-icon haven-glyph' + (data.icons[id].spin ? ' haven-icon-spin' : '');
    el.setAttribute('data-icon', id);
    el.setAttribute('data-glyph', glyph(id));
    el.setAttribute('data-emoji', emoji);
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function swapNode(node) {
    if (!node || node.nodeType !== 3 || !node.data) return;
    var parent = node.parentElement;
    var host = hostOf(parent);
    if (!parent || !host || excluded(parent, host)) return;
    var explicit = !!(host.matches && host.matches(EXPLICIT_SELECTOR));
    var text = node.data;
    var fragment = doc.createDocumentFragment();
    var found = false;
    while (true) {
      var index = -1;
      var hit = null;
      for (var i = 0; i < KEYS.length; i++) {
        var at = text.indexOf(KEYS[i]);
        // Outside explicit hosts only a leading emoji is an affordance; one in
        // the middle of a sentence is part of the sentence.
        if (at !== -1 && (explicit || /^\s*$/.test(text.slice(0, at))) && (index === -1 || at < index)) {
          index = at;
          hit = KEYS[i];
        }
      }
      if (hit === null) break;
      var id = iconFor(hit, host);
      if (!id) break;
      found = true;
      if (index > 0) fragment.appendChild(doc.createTextNode(text.slice(0, index)));
      fragment.appendChild(makeIcon(id, hit));
      text = text.slice(index + hit.length);
    }
    if (!found) return;
    if (text) fragment.appendChild(doc.createTextNode(text));
    node.replaceWith(fragment);
    if (parent.isConnected) parent.normalize();
  }

  function sweep(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { swapNode(rootNode); return; }
    if (rootNode.nodeType !== 1 || (rootNode.classList && rootNode.classList.contains('haven-icon'))) return;
    var walker = doc.createTreeWalker(rootNode, 4 /* NodeFilter.SHOW_TEXT */);
    var nodes = [];
    var current;
    while ((current = walker.nextNode())) nodes.push(current);
    nodes.forEach(swapNode);
  }

  function restoreAll() {
    var icons = doc.querySelectorAll('i.haven-icon[data-emoji]');
    var parents = [];
    Array.prototype.forEach.call(icons, function (icon) {
      var parent = icon.parentNode;
      icon.replaceWith(doc.createTextNode(icon.getAttribute('data-emoji')));
      if (parent && parents.indexOf(parent) < 0) parents.push(parent);
    });
    parents.forEach(function (p) { if (p.isConnected) p.normalize(); });
  }

  function startObserver() {
    if (observer || !doc.body || typeof win.MutationObserver !== 'function') return;
    observer = new win.MutationObserver(function (mutations) {
      if (busy) return;
      busy = true;
      try {
        mutations.forEach(function (m) {
          if (m.type === 'characterData') swapNode(m.target);
          else Array.prototype.forEach.call(m.addedNodes, function (n) {
            if (n.nodeType === 3) swapNode(n);
            else if (n.nodeType === 1) sweep(n);
          });
        });
      } finally {
        busy = false;
      }
    });
    observer.observe(doc.body, { childList: true, characterData: true, subtree: true });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
  }

  function apply(next) {
    var prev = mode;
    mode = normalize(next) || DEFAULT_MODE;
    var rootEl = doc.documentElement;
    // Font packs draw the toolbars from their emoji twins, like Glyphs did.
    rootEl.setAttribute('data-toolbaricons', isFontPack(mode) ? 'emoji' : mode);
    rootEl.setAttribute('data-icon-pack', mode);
    if (isFontPack(mode)) {
      if (doc.body) {
        busy = true;
        try { sweep(doc.body); } finally { busy = false; }
        startObserver();
      }
    } else {
      stopObserver();
      if (isFontPack(prev)) restoreAll();
    }
    if (prev !== mode && typeof win.CustomEvent === 'function') {
      doc.dispatchEvent(new win.CustomEvent('haven:icon-pack-change', { detail: { mode: mode, previous: prev } }));
    }
    return mode;
  }

  // Re-reads the saved choice and the theme; used at start and on theme change.
  function refresh() { return apply(resolve(readSaved(), themeId())); }

  // A member's pick: saved, so it wins over any theme suggestion.
  function choose(next) {
    var value = normalize(next) || DEFAULT_MODE;
    try { win.localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* storage blocked: applies for this visit only */ }
    return apply(value);
  }

  api.current = function () { return mode; };
  api.saved = function () { return normalize(readSaved()); };
  api.apply = apply;
  api.refresh = refresh;
  api.choose = choose;
  api.sweep = sweep;

  // Themes switch through data-theme on <html>; follow them while nothing is saved.
  if (typeof win.MutationObserver === 'function') {
    new win.MutationObserver(function () {
      if (!api.saved()) refresh();
    }).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // Loaded at the end of <body>, so the page is there to sweep straight away.
  if (doc.body) refresh();
  else doc.addEventListener('DOMContentLoaded', refresh);

  return api;
}));

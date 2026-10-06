(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HavenThemeCompat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CACHE_KEY = 'haven_theme_compatibility';
  const CACHE_SCHEMA = 1;
  const SAFE_MODE_KEY = 'haven_safe_mode';
  const RESET_PENDING_KEY = 'haven_customizations_reset_pending';
  let themeRequest = null;

  function getStorage(storage, fallbackName) {
    if (storage) return storage;
    try { return globalThis[fallbackName]; } catch { return null; }
  }

  function cacheThemes(themes, storage) {
    const target = getStorage(storage, 'localStorage');
    if (!target || !Array.isArray(themes)) return;

    const entries = {};
    for (const theme of themes) {
      if (!theme || typeof theme.file !== 'string') continue;
      const compatibility = typeof theme.compatibility === 'string'
        ? theme.compatibility
        : 'legacy';
      const layout = typeof theme.layout === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(theme.layout)
        ? theme.layout
        : '';
      entries[theme.file] = {
        compatible: theme.compatible !== false && !['invalid', 'unsupported'].includes(compatibility),
        compatibility,
        themeApi: Number.isInteger(theme.themeApi) ? theme.themeApi : null,
        themeApiDeclared: theme.themeApiDeclared == null ? null : String(theme.themeApiDeclared),
        layout,
      };
    }

    try {
      target.setItem(CACHE_KEY, JSON.stringify({ schema: CACHE_SCHEMA, themes: entries }));
    } catch { /* storage unavailable */ }
  }

  function getCachedTheme(file, storage) {
    if (typeof file !== 'string' || !file) return null;
    const target = getStorage(storage, 'localStorage');
    if (!target) return null;
    try {
      const cache = JSON.parse(target.getItem(CACHE_KEY) || 'null');
      if (!cache || cache.schema !== CACHE_SCHEMA || typeof cache.themes !== 'object') return null;
      return cache.themes[file] || null;
    } catch {
      return null;
    }
  }

  function fetchThemes(fetcher, force = false) {
    if (themeRequest && !force) return themeRequest;
    let request = fetcher;
    if (typeof request !== 'function') {
      try { request = globalThis.fetch?.bind(globalThis); } catch { request = null; }
    }
    if (typeof request !== 'function') return Promise.resolve(null);

    themeRequest = new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(null), 5000);
      Promise.resolve()
        .then(() => request('/api/themes'))
        .then(response => {
          if (!response || response.ok === false) throw new Error('Theme metadata request failed');
          return response.json();
        })
        .then(themes => finish(Array.isArray(themes) ? themes : null))
        .catch(() => finish(null));
    });
    return themeRequest;
  }

  function requestedSafeMode(locationLike) {
    try {
      return new URLSearchParams(locationLike?.search || '').get('haven-safe-mode');
    } catch {
      return null;
    }
  }

  function isSafeMode(locationLike, storage) {
    const session = getStorage(storage, 'sessionStorage');
    const requested = requestedSafeMode(locationLike || globalThis.location);
    try {
      if (requested === '1') session?.setItem(SAFE_MODE_KEY, '1');
      if (requested === '0') session?.removeItem(SAFE_MODE_KEY);
      return requested === '1' || (requested !== '0' && session?.getItem(SAFE_MODE_KEY) === '1');
    } catch {
      return requested === '1';
    }
  }

  function clearSafeMode(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { session?.removeItem(SAFE_MODE_KEY); } catch { /* storage unavailable */ }
  }

  function markResetPending(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { session?.setItem(RESET_PENDING_KEY, '1'); } catch { /* storage unavailable */ }
  }

  function isResetPending(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { return session?.getItem(RESET_PENDING_KEY) === '1'; } catch { return false; }
  }

  function clearResetPending(storage) {
    const session = getStorage(storage, 'sessionStorage');
    try { session?.removeItem(RESET_PENDING_KEY); } catch { /* storage unavailable */ }
  }

  function resetLocalCustomizations(local, session) {
    const storage = getStorage(local, 'localStorage');
    try {
      storage?.setItem('haven_theme', 'haven');
      storage?.setItem('haven_enabled_themes', '[]');
      storage?.setItem('haven_enabled_plugins', '[]');
    } catch { /* storage unavailable */ }
    markResetPending(session);
  }

  // A theme opts into the Seasonal group with `@section Seasonal` (or
  // `@category Holiday`) in its header.
  const isSeasonalTheme = theme => /^(seasonal|holiday)$/i.test(String(theme?.section || theme?.category || ''));
  function urlWithoutSafeMode(locationLike) {
    try {
      const url = new URL(locationLike?.href || globalThis.location.href);
      url.searchParams.delete('haven-safe-mode');
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '/';
    }
  }

  // Native controls (the list a <select> opens, scrollbars, date pickers) are
  // drawn by the browser, which only knows light or dark through
  // color-scheme. A theme's page background decides which it is, so
  // built-in, published and Custom themes need no list kept by hand.
  // Takes a CSS color as #rgb, #rrggbb(aa), rgb()/rgba() or color(srgb ...),
  // and returns 'light', 'dark', or null when it cannot tell.
  function parseColor(value) {
    const text = String(value || '').trim().toLowerCase();
    let match = text.match(/^#([0-9a-f]{3,8})$/);
    if (match) {
      let hex = match[1];
      if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('');
      if (hex.length !== 6 && hex.length !== 8) return null;
      const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(alpha);
    }
    match = text.match(/^rgba?\(([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const channel = p => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
      const alpha = parts[3] === undefined ? 1
        : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
      const rgb = parts.slice(0, 3).map(channel);
      return rgb.some(Number.isNaN) || Number.isNaN(alpha) ? null : rgb.concat(alpha);
    }
    match = text.match(/^color\(srgb\s+([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
      return parts.slice(0, 3).map(c => c * 255).concat(parts[3] === undefined ? 1 : parts[3]);
    }
    return null;
  }

  function colorSchemeFor(color) {
    const rgba = parseColor(color);
    // A see-through background takes its look from what is behind it.
    if (!rgba || rgba[3] < 0.5) return null;
    const lin = c => {
      const v = Math.min(255, Math.max(0, c)) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * lin(rgba[0]) + 0.7152 * lin(rgba[1]) + 0.0722 * lin(rgba[2]);
    // Light when black text would read better on it than white text does.
    return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? 'light' : 'dark';
  }

  return {
    CACHE_KEY,
    SAFE_MODE_KEY,
    RESET_PENDING_KEY,
    cacheThemes,
    getCachedTheme,
    fetchThemes,
    isSafeMode,
    clearSafeMode,
    markResetPending,
    isResetPending,
    clearResetPending,
    resetLocalCustomizations,
    urlWithoutSafeMode,
    isSeasonalTheme,
    colorSchemeFor,
  };
});

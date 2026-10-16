// The theme picker's logic, kept apart from the DOM so it can be tested:
// which themes a viewer sees, how they are grouped, what a search matches,
// and where an arrow key moves the focus. The picker itself is
// public/js/modules/app-theme-picker.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HavenThemeGallery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Sections in the order the picker shows them. Community themes come first
  // so they are easy to find; a file can name its own section with
  // `@section`, and those sit between Community and Seasonal.
  const SECTION_ORDER = ['community', 'named', 'seasonal', 'available', 'builtin'];

  const fold = value => String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  function isSeasonal(theme) {
    return /^(seasonal|holiday)$/i.test(String(theme?.section || theme?.category || ''));
  }

  function sectionKey(theme) {
    if (isSeasonal(theme)) return 'seasonal';
    const named = String(theme?.section || '').trim();
    return named && !/^community$/i.test(named) ? `named:${named}` : 'community';
  }

  // A full theme replaces the palette and is the one selected theme. A file
  // that sets no palette and is not published only adds CSS on top of the
  // selected theme, so the picker switches it on and off instead.
  function isOverlay(theme) {
    return !(theme.published || theme.palette || theme.layout);
  }

  function fileEntry(theme) {
    return {
      kind: 'file',
      id: `file:${theme.file}`,
      file: theme.file,
      name: theme.name || theme.file.replace(/\.theme\.css$/i, ''),
      author: theme.author || '',
      description: theme.description || '',
      icon: theme.icon || '',
      swatch: theme.swatch || null,
      published: !!theme.published,
      overlay: isOverlay(theme),
      enabled: !!theme.enabled,
      section: sectionKey(theme),
      keywords: [theme.section, theme.category].filter(Boolean).join(' '),
    };
  }

  // Every word of the search has to appear somewhere in the theme's name,
  // author, description or section (keywords). Accents and case are ignored.
  function matches(entry, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = fold([entry.name, entry.author, entry.description, entry.keywords].join(' '));
    return words.every(word => haystack.includes(word));
  }

  function sectionRank(key) {
    const base = key.startsWith('named:') ? 'named' : key;
    return SECTION_ORDER.indexOf(base);
  }

  // builtins: [{ id, name, icon, keywords }] in the order the picker lists them.
  // themes: the server's theme list, with `enabled` from the loader.
  // Members see the built-in themes and whatever the admin published (plus
  // their own current pick if it has since been unpublished). Admins also see
  // the compatible themes nobody has published yet, in their own section.
  function buildSections({ builtins = [], themes = [], isAdmin = false, activeTheme = '', query = '' } = {}) {
    const groups = new Map();
    const add = (key, entry) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    };

    const files = themes
      .filter(theme => theme && typeof theme.file === 'string' && theme.compatible !== false)
      .map(fileEntry)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const entry of files) {
      if (entry.published) add(entry.section, entry);
      else if (isAdmin) add('available', entry);
      else if (entry.id === activeTheme || (entry.overlay && entry.enabled)) add(entry.section, entry);
    }
    for (const theme of builtins) {
      add('builtin', { kind: 'builtin', id: theme.id, name: theme.name, icon: theme.icon || '', keywords: theme.keywords || '' });
    }

    return [...groups.keys()]
      .sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b))
      .map(key => {
        const all = groups.get(key);
        return {
          key,
          name: key.startsWith('named:') ? key.slice(6) : '',
          total: all.length,
          entries: all.filter(entry => matches(entry, query)),
        };
      })
      .filter(section => section.entries.length > 0);
  }

  // The colours a theme file's card is drawn in. A file that names only some
  // of them still gets a readable card in any page theme: the panel falls
  // back to the background, and the text to dark or light ink by how light
  // the panel is (schemeFor is HavenThemeCompat.colorSchemeFor), never to
  // the page's own text colour.
  function cardColors(swatch, schemeFor) {
    const colors = { ...(swatch || {}) };
    if (colors.bg && !colors.panel) colors.panel = colors.bg;
    if (colors.panel && !colors.text && typeof schemeFor === 'function') {
      const scheme = schemeFor(colors.panel);
      if (scheme === 'light') colors.text = '#16181d';
      else if (scheme === 'dark') colors.text = '#f2f3f5';
    }
    return colors;
  }

  // Whether a card shows as chosen: the selected theme, or an add-on that is on.
  function isPressed(entry, activeTheme) {
    if (entry.kind === 'file' && entry.overlay) return entry.enabled;
    return entry.id === (activeTheme || 'haven');
  }

  function parsePublished(value) {
    try {
      const list = JSON.parse(value || '[]');
      return Array.isArray(list) ? list.filter(file => typeof file === 'string') : [];
    } catch {
      return []; // malformed setting: nothing counts as published
    }
  }

  // The published list after one theme is published or taken back.
  function nextPublishedList(current, file, publish) {
    const list = [...new Set(Array.isArray(current) ? current : [])].filter(item => item !== file);
    return publish ? [...list, file] : list;
  }

  // Where an arrow key moves the focus, given each visible card's box in
  // reading order. Up and down go to the nearest row in that direction and
  // the card closest across, so moving down out of a short section lands in
  // the next one.
  function moveIndex(boxes, from, key) {
    if (!boxes.length) return -1;
    if (key === 'Home') return 0;
    if (key === 'End') return boxes.length - 1;
    if (from < 0 || from >= boxes.length) return 0;
    if (key === 'ArrowRight') return Math.min(from + 1, boxes.length - 1);
    if (key === 'ArrowLeft') return Math.max(from - 1, 0);
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return from;

    const middle = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    const here = middle(boxes[from]);
    const down = key === 'ArrowDown';
    const tolerance = Math.max(2, boxes[from].height / 2);
    let rowY = null;
    for (const box of boxes) {
      const { y } = middle(box);
      const ahead = down ? y > here.y + tolerance : y < here.y - tolerance;
      if (ahead && (rowY === null || (down ? y < rowY : y > rowY))) rowY = y;
    }
    if (rowY === null) return from;

    let best = from;
    let bestDistance = Infinity;
    boxes.forEach((box, index) => {
      const { x, y } = middle(box);
      if (Math.abs(y - rowY) > tolerance) return;
      const distance = Math.abs(x - here.x);
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    return best;
  }

  return {
    SECTION_ORDER,
    buildSections,
    cardColors,
    isOverlay,
    isPressed,
    isSeasonal,
    matches,
    moveIndex,
    nextPublishedList,
    parsePublished,
    sectionKey,
  };
});

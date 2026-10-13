'use strict';

// Interface icon packs (Settings > Appearance > Icons). icon-packs-data.js is
// generated from the icon registry the web, Android and iOS clients share;
// icon-packs.js resolves the pack and swaps interface emoji for it. These
// tests run both files the way a browser does, without a DOM where the logic
// does not need one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { readCoreCss } = require('./coreCss');
const { BUILTIN_THEMES } = require('../src/themeMetadata');
const md = require('../src/memberDefaults');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function loadData() {
  const sandbox = { window: {} };
  vm.runInNewContext(read('public/js/icon-packs-data.js'), sandbox);
  return sandbox.window.HAVEN_ICON_DATA;
}

const DATA = loadData();
const factory = require('../public/js/icon-packs.js');
const icons = factory(DATA);

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

// The browser half without a page body: enough to see what lands on <html>.
function browser(stored = {}, theme = '') {
  const attributes = new Map(theme ? [['data-theme', theme]] : []);
  const events = [];
  const document = {
    readyState: 'loading',
    body: null,
    documentElement: {
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
    },
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
    querySelectorAll() { return []; },
  };
  const localStorage = new MemoryStorage(stored);
  const win = {
    document, localStorage,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  };
  return { api: factory(DATA, win), attributes, events, localStorage };
}

test('the generated data gives every icon one private-use character, in order', () => {
  const ids = Object.keys(DATA.icons);
  assert.ok(ids.length >= 190, `only ${ids.length} icons`);
  ids.forEach((id, i) => assert.equal(DATA.icons[id].cp, 0xe000 + i, id));
  assert.deepEqual([...DATA.packs.map(p => p.id)], ['emoji', 'glyphs', 'line', 'native']);
  for (const id of ['settings', 'notes', 'games', 'admin', 'pin', 'lock', 'mic', 'mute', 'search', 'members',
    'threads', 'reply', 'edit', 'delete', 'copy', 'link', 'warning', 'bot', 'send', 'download', 'owner']) {
    assert.ok(DATA.icons[id], `${id} is missing`);
  }
  assert.equal(icons.glyph('settings'), '');
  assert.equal(icons.glyph('nope'), '');
});

test('no emoji stands for two icons', () => {
  const seen = new Map();
  for (const [id, icon] of Object.entries(DATA.icons)) {
    for (const emoji of icon.emoji) {
      assert.ok(!seen.has(emoji), `${emoji} is on both ${seen.get(emoji)} and ${id}`);
      seen.set(emoji, id);
    }
  }
});

test('each font pack ships a small local subset and its license', () => {
  const notice = read('public/fonts/NOTICE.txt');
  for (const pack of DATA.packs.filter(p => p.font)) {
    const file = `public/fonts/haven-icons-${pack.id}.woff2`;
    const size = fs.statSync(path.join(ROOT, file)).size;
    assert.ok(size > 4_000 && size < 60_000, `${file} is ${size} bytes`);
    assert.equal(fs.readFileSync(path.join(ROOT, file)).subarray(0, 4).toString('latin1'), 'wOF2');
    assert.ok(notice.includes(`haven-icons-${pack.id}.woff2`), `NOTICE.txt does not mention ${file}`);
  }
  assert.match(notice, /Font Awesome Free 6\.7\.2/);
  assert.match(notice, /Reserved Font\s+Name/);
  assert.match(notice, /Lucide/);
  assert.match(notice, /ISC/);
  assert.match(notice, /Material Symbols/);
  assert.match(notice, /Apache License\s+2\.0/);
  for (const f of ['LICENSE-FontAwesome-Free.txt', 'LICENSE-Lucide.txt', 'LICENSE-MaterialSymbols.txt']) {
    assert.ok(fs.statSync(path.join(ROOT, 'public/fonts', f)).size > 500, f);
  }
  // The full Font Awesome font is gone; nothing may still ask for it.
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/fonts/fa-solid-900.woff2')));
  assert.doesNotMatch(read('public/app.html') + readCoreCss() + read('plugins/HavenGlyphs.plugin.js'), /fa-solid-900/);
});

test('the stylesheet defines the three families and keys them off data-icon-pack', () => {
  const css = readCoreCss();
  for (const [pack, family] of [['glyphs', 'HavenIconsGlyphs'], ['line', 'HavenIconsLine'], ['native', 'HavenIconsNative']]) {
    assert.match(css, new RegExp(`font-family: '${family}';[\\s\\S]*?url\\('/fonts/haven-icons-${pack}\\.woff2`));
    assert.match(css, new RegExp(`html\\[data-icon-pack="${pack}"\\] \\.haven-icon \\{ font-family: '${family}'; \\}`));
  }
  assert.match(css, /\.haven-icon::before \{ content: attr\(data-glyph\); \}/);
  assert.match(css, /\.user-action-btn > \.haven-icon \{ color: var\(--text-secondary\); \}/);
  assert.match(css, /html\.reduce-motion \.haven-icon-spin \{ animation: none; \}/);
  assert.doesNotMatch(css.slice(css.indexOf('ICON PACKS')), /https?:\/\/(?!scripts|creativecommons)/);
});

test('a saved pick wins, then the theme suggestion, then Monochrome', () => {
  assert.equal(icons.resolve(null, null), 'mono');
  assert.equal(icons.resolve(null, 'haven'), 'mono');
  assert.equal(icons.resolve(null, 'matrix'), 'line');
  assert.equal(icons.resolve(null, 'MATRIX'), 'line');
  assert.equal(icons.resolve(null, 'win95'), 'glyphs');
  assert.equal(icons.resolve('native', 'matrix'), 'native');
  assert.equal(icons.resolve('mono', 'matrix'), 'mono');
  assert.equal(icons.resolve('emoji', 'win95'), 'emoji');
  assert.equal(icons.resolve('bogus', 'win95'), 'glyphs');
  for (const theme of Object.keys(DATA.themes)) assert.ok(BUILTIN_THEMES.includes(theme), `${theme} is not a built-in theme`);
});

test('old saved values keep working', () => {
  assert.equal(icons.normalize('color'), 'emoji');
  for (const v of ['mono', 'emoji', 'glyphs', 'line', 'native']) assert.equal(icons.normalize(v), v);
  assert.equal(icons.normalize('Glyphs'), null);
  assert.equal(icons.normalize(''), null);
});

test('interface emoji the Haven Glyphs plugin handled still map to the same icons', () => {
  const expected = {
    '⚙️': 'settings', '⚙': 'settings', '🔍': 'search', '📌': 'pin', '🧵': 'threads', '🎤': 'mic',
    '🔇': 'mute', '🔊': 'speaker', '🔒': 'lock', '🔐': 'lock', '⚠️': 'warning', '⚠': 'warning',
    '👥': 'members', '👑': 'owner', '🤖': 'bot', '🛡️': 'admin', '📝': 'notes', '🗑️': 'delete',
    '✏️': 'edit', '↩️': 'reply', '🔗': 'link', '📋': 'clipboard', '🎮': 'games', '📥': 'download',
    '🎵': 'music', '🎶': 'headphones', '⏳': 'loading', '👁️‍🗨️': 'view', '▲': 'caret-up', '▼': 'caret-down',
  };
  for (const [emoji, id] of Object.entries(expected)) assert.equal(icons.iconIdFor(emoji), id, emoji);
  assert.equal(icons.iconIdFor('🦄'), null);
  // Longest first, so a joined sequence is not split after its first emoji.
  assert.ok(icons.aliases.indexOf('👁️‍🗨️') < icons.aliases.indexOf('👁'));
  assert.equal(DATA.icons.loading.spin, true);
});

test('font packs draw the toolbars from their emoji twins and announce the change', () => {
  const b = browser();
  assert.equal(b.api.refresh(), 'mono');
  assert.equal(b.attributes.get('data-toolbaricons'), 'mono');
  assert.equal(b.attributes.get('data-icon-pack'), 'mono');
  assert.equal(b.api.choose('line'), 'line');
  assert.equal(b.localStorage.getItem('haven-toolbar-icons'), 'line');
  assert.equal(b.attributes.get('data-toolbaricons'), 'emoji');
  assert.equal(b.attributes.get('data-icon-pack'), 'line');
  assert.deepEqual(b.events.map(e => [e.type, e.detail.mode, e.detail.previous]), [['haven:icon-pack-change', 'line', 'mono']]);
  b.api.choose('emoji');
  assert.equal(b.attributes.get('data-toolbaricons'), 'emoji');
  assert.equal(b.api.saved(), 'emoji');
});

test('without a saved pick the theme decides, and a pick then sticks', () => {
  const b = browser({}, 'crt');
  assert.equal(b.api.refresh(), 'line');
  assert.equal(b.api.saved(), null, 'a theme suggestion is not saved');
  b.attributes.set('data-theme', 'win95');
  assert.equal(b.api.refresh(), 'glyphs');
  b.api.choose('mono');
  b.attributes.set('data-theme', 'matrix');
  assert.equal(b.api.refresh(), 'mono');
  assert.equal(browser({ 'haven-toolbar-icons': 'color' }, 'matrix').api.refresh(), 'emoji');
});

test('the Haven Glyphs plugin is a stub that selects the Glyphs pack', () => {
  const HavenGlyphs = require('../plugins/HavenGlyphs.plugin.js');
  const source = read('plugins/HavenGlyphs.plugin.js');
  assert.match(source, /@author bernardokcosta/);
  assert.doesNotMatch(source, /MutationObserver|@font-face|https?:\/\//);
  const b = browser({ 'haven-toolbar-icons': 'mono' });
  b.api.refresh();
  global.window = { HavenIcons: b.api };
  try {
    const plugin = new HavenGlyphs();
    plugin.start();
    assert.equal(b.api.current(), 'glyphs');
    assert.equal(b.api.saved(), 'glyphs');
    plugin.stop();
    assert.equal(b.api.current(), 'emoji', 'turning the plugin off looks like it used to');
    b.api.choose('native');
    plugin.stop();
    assert.equal(b.api.current(), 'native', 'a later pick is left alone');
  } finally {
    delete global.window;
  }
});

test('the sweep keeps its host, exclusion and special-case rules', () => {
  const source = read('public/js/icon-packs.js');
  for (const host of ['.channel-hash', '.voice-status-icon', '.pinned-tag', '.tb-icon-emoji', '.settings-nav-item', '[data-haven-icon]', '.file-icon']) {
    assert.ok(source.includes(`'${host}'`), `${host} is not a host`);
  }
  for (const guarded of ['.message-content', '.reaction', '.emoji-only-msg', '.soundboard-btn', '.channel-name', '.profile-bio', '.reply-preview', '[data-user-content]', '#emoji-picker', 'input, textarea, select, option']) {
    assert.ok(source.includes(guarded), `${guarded} is not protected`);
  }
  assert.match(source, /#voice-deafen-btn, #voice-deafen-btn-header/);
  assert.match(source, /setAttribute\('aria-hidden', 'true'\)/);
  assert.match(source, /data-emoji/);
});

test('the picker offers every pack, with a live preview, and loads the pack code before app.js', () => {
  const html = read('public/app.html');
  for (const v of ['mono', 'emoji', 'glyphs', 'line', 'native']) assert.match(html, new RegExp(`data-toolbaricons="${v}"`));
  assert.match(html, /id="icon-pack-preview"[^>]*role="img"/);
  const data = html.indexOf('/js/icon-packs-data.js');
  const code = html.indexOf('/js/icon-packs.js');
  const app = html.indexOf('/js/app.js');
  assert.ok(data > 0 && data < code && code < app);
  const en = JSON.parse(read('public/locales/en.json'));
  for (const key of ['line', 'line_hint', 'native', 'native_hint', 'preview_label']) assert.ok(en.settings.toolbar_icons[key], key);
});

test('member defaults accept every pack and nothing else', () => {
  for (const v of ['mono', 'emoji', 'glyphs', 'line', 'native']) {
    assert.deepEqual(md.cleanSettings({ interface_icons: v }), { interface_icons: v });
  }
  assert.deepEqual(md.cleanSettings({ interface_icons: 'color' }), {});
  assert.deepEqual(md.cleanSettings({ interface_icons: 'sparkly' }), {});
  const client = read('public/js/modules/app-member-defaults.js');
  assert.match(client, /\['mono', 'emoji', 'glyphs', 'line', 'native'\]/);
  assert.doesNotMatch(client, /HavenGlyphs\.plugin\.js/, 'Glyphs no longer waits for the plugin');
});

// The template names sit in a native <select>, which the sweep cannot draw
// into, so they keep their emoji for everyone; the delete prompt drops the
// marker again.
test('native channel template options keep their emoji', () => {
  const roleTools = read('public/js/modules/app-role-tools.js');
  assert.match(roleTools, /label: `\$\{tp\.emoji\} /);
  assert.match(roleTools, /label: `💾 /);
  assert.match(roleTools, /replace\(\/\^💾 \//);
});

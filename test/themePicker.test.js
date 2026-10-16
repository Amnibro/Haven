'use strict';

// The theme picker gallery: preview colours from the server, the picker's
// own logic (search, sections, who sees what) and who may publish.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { parseThemeMetadata, readThemeMetadataSnapshot, themeSwatch } = require('../src/themeMetadata');
const registerAdmin = require('../src/socketHandlers/admin');
const Gallery = require('../public/js/theme-gallery');

const ROOT = path.join(__dirname, '..');

test('a palette theme carries its preview colours', () => {
  const meta = parseThemeMetadata(`/** @name Neon */
:root { --bg-primary: #03070d; --bg-secondary:#06101a; --accent-hover: #fff; --accent: rgb(0, 229, 255); --text-primary: #e8fbff; }`);
  assert.deepEqual(meta.swatch, { bg: '#03070d', panel: '#06101a', accent: 'rgb(0, 229, 255)', text: '#e8fbff' });
});

test('preview colours take only plain colour values', () => {
  assert.equal(themeSwatch(':root { --bg-primary: var(--x); }'), null);
  assert.equal(themeSwatch(':root { --bg-primary: url(https://example.test/a.png); }'), null);
  assert.deepEqual(
    themeSwatch(':root { --bg-primary: #000; --accent: expression(alert(1)); --text-primary: #fff" onload="x; }'),
    { bg: '#000' },
  );
  // A token whose name only ends in --bg-primary is not the palette's own.
  assert.equal(themeSwatch(':root { --braid-bg-primary: #123456; }'), null);
  assert.equal(themeSwatch(null), null);
});

test('every bundled theme has preview colours', () => {
  for (const theme of readThemeMetadataSnapshot(path.join(ROOT, 'themes'))) {
    assert.ok(theme.swatch?.bg && theme.swatch?.accent, `${theme.file} has no preview colours`);
  }
});

// ── Picker logic (public/js/theme-gallery.js) ──────────────────────────

const BUILTINS = [
  { id: 'haven', name: 'Haven' },
  { id: 'matrix', name: 'Matrix' },
  { id: 'daylight', name: 'Daylight', keywords: 'Light' },
];
const THEMES = [
  { file: 'glassy-neon.theme.css', name: 'Glassy Neon', author: 'Amnibro', description: 'Frosted holo-glass panels', palette: true, published: true, compatible: true },
  { file: 'braid.theme.css', name: 'Braid', author: 'Amnibro', description: 'Mint on slate', palette: true, published: false, compatible: true },
  { file: 'halloween.theme.css', name: 'Halloween', author: 'Amnibro', section: 'Seasonal', palette: true, published: true, compatible: true },
  { file: 'christmas.theme.css', name: 'Christmas', author: 'Amnibro', section: 'Seasonal', palette: true, published: false, compatible: true },
  { file: 'retro.theme.css', name: 'Retro Pack', author: 'Someone', section: 'Retro', palette: true, published: true, compatible: true },
  { file: 'future.theme.css', name: 'Future', palette: true, published: true, compatible: false },
  { file: 'fonts.theme.css', name: 'Big Fonts', palette: false, published: false, compatible: true },
];
const shape = sections => sections.map(s => `${s.key}:${s.entries.map(e => e.name).join(',')}`);

test('members see the built-in themes and the published ones, grouped in order', () => {
  const sections = Gallery.buildSections({ builtins: BUILTINS, themes: THEMES, isAdmin: false, activeTheme: 'haven' });
  assert.deepEqual(shape(sections), [
    'community:Glassy Neon',
    'named:Retro:Retro Pack',
    'seasonal:Halloween',
    'builtin:Haven,Matrix,Daylight',
  ]);
  assert.equal(sections[1].name, 'Retro');
});

test('admins also see every compatible unpublished theme, in its own section', () => {
  const sections = Gallery.buildSections({ builtins: BUILTINS, themes: THEMES, isAdmin: true, activeTheme: 'haven' });
  assert.deepEqual(shape(sections), [
    'community:Glassy Neon',
    'named:Retro:Retro Pack',
    'seasonal:Halloween',
    'available:Big Fonts,Braid,Christmas',
    'builtin:Haven,Matrix,Daylight',
  ]);
  // An incompatible file is never offered, published or not.
  assert.ok(!sections.flatMap(s => s.entries).some(e => e.file === 'future.theme.css'));
});

test('a member keeps their own pick in view after it is unpublished', () => {
  const sections = Gallery.buildSections({ builtins: [], themes: THEMES, isAdmin: false, activeTheme: 'file:braid.theme.css' });
  assert.deepEqual(shape(sections), ['community:Braid,Glassy Neon', 'named:Retro:Retro Pack', 'seasonal:Halloween']);
  // The other unpublished themes stay hidden from members.
  assert.ok(!shape(sections).join().includes('Christmas'));
});

test('search matches name, author, description and section, ignoring case and accents', () => {
  const names = query => Gallery.buildSections({ builtins: BUILTINS, themes: THEMES, isAdmin: true, query })
    .flatMap(s => s.entries.map(e => e.name));
  assert.deepEqual(names('NEON'), ['Glassy Neon']);
  assert.deepEqual(names('amnibro seasonal'), ['Halloween', 'Christmas']);
  assert.deepEqual(names('holo glass'), ['Glassy Neon']);
  assert.deepEqual(names('retro'), ['Retro Pack']);
  assert.deepEqual(names('light'), ['Daylight']);
  assert.deepEqual(names('mátrix'), ['Matrix']);
  assert.deepEqual(names('nothing like this'), []);
  // Sections report how many they hold in all, for the "2/28" count.
  const builtin = Gallery.buildSections({ builtins: BUILTINS, query: 'a' }).find(s => s.key === 'builtin');
  assert.equal(builtin.total, 3);
});

test('a theme that only adds CSS is pressed while on; a full theme while selected', () => {
  const [fonts] = Gallery.buildSections({ themes: [{ ...THEMES[6], enabled: true }], isAdmin: true })[0].entries;
  assert.equal(fonts.overlay, true);
  assert.equal(Gallery.isPressed(fonts, 'matrix'), true);
  const [neon] = Gallery.buildSections({ themes: [THEMES[0]] })[0].entries;
  assert.equal(neon.overlay, false);
  assert.equal(Gallery.isPressed(neon, 'file:glassy-neon.theme.css'), true);
  assert.equal(Gallery.isPressed(neon, 'matrix'), false);
  assert.equal(Gallery.isPressed({ kind: 'builtin', id: 'haven' }, ''), true);
});

test('publishing and taking back one theme changes only that entry', () => {
  assert.deepEqual(Gallery.nextPublishedList(['a.theme.css'], 'b.theme.css', true), ['a.theme.css', 'b.theme.css']);
  assert.deepEqual(Gallery.nextPublishedList(['a.theme.css', 'b.theme.css'], 'a.theme.css', false), ['b.theme.css']);
  assert.deepEqual(Gallery.nextPublishedList(['a.theme.css', 'a.theme.css'], 'a.theme.css', true), ['a.theme.css']);
  assert.deepEqual(Gallery.parsePublished('["a.theme.css", 3]'), ['a.theme.css']);
  assert.deepEqual(Gallery.parsePublished('not json'), []);
  assert.deepEqual(Gallery.parsePublished('{"a":1}'), []);
});

test('arrow keys move by card and by row, across sections', () => {
  // Two columns; a section of three cards, then a section of two lower down.
  const box = (col, top) => ({ left: col * 100, top, width: 90, height: 50 });
  const boxes = [box(0, 0), box(1, 0), box(0, 60), box(0, 150), box(1, 150)];
  assert.equal(Gallery.moveIndex(boxes, 0, 'ArrowRight'), 1);
  assert.equal(Gallery.moveIndex(boxes, 1, 'ArrowDown'), 2); // closest across in the next row
  assert.equal(Gallery.moveIndex(boxes, 2, 'ArrowDown'), 3); // into the next section
  assert.equal(Gallery.moveIndex(boxes, 4, 'ArrowUp'), 2);
  assert.equal(Gallery.moveIndex(boxes, 4, 'ArrowDown'), 4); // nowhere further down
  assert.equal(Gallery.moveIndex(boxes, 0, 'ArrowLeft'), 0);
  assert.equal(Gallery.moveIndex(boxes, 2, 'End'), 4);
  assert.equal(Gallery.moveIndex(boxes, 3, 'Home'), 0);
  assert.equal(Gallery.moveIndex([], 0, 'ArrowDown'), -1);
});

// ── Who may publish (src/socketHandlers/admin.js) ──────────────────────

function publishHarness({ isAdmin = false, manageServer = false } = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT)');
  const handlers = new Map();
  const outgoing = [];
  const broadcasts = [];
  const socket = {
    user: { id: 7, isAdmin },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { outgoing.push({ event, payload }); },
  };
  const io = {
    sockets: { sockets: new Map() },
    of() { return { sockets: new Map() }; },
    except() { return { emit(event, payload) { broadcasts.push({ event, payload }); } }; },
    to() { return { emit() {} }; },
  };
  registerAdmin(socket, {
    io,
    db,
    state: { channelUsers: new Map() },
    userHasPermission: (_id, perm) => manageServer && perm === 'manage_server',
    getUserEffectiveLevel: () => (isAdmin ? 100 : 1),
    getUserPermissions: () => [],
    getUserRoles: () => [],
    getUserHighestRole: () => null,
    emitOnlineUsers() {},
    broadcastChannelLists() {},
    generateUniqueSharedCode: () => '12345678',
    logAudit() {},
    fireWebhookEvent() {},
    onReferrerPolicyChange() {},
    automod: { invalidate() {}, settings: () => ({}) },
    getIdleOnlineUsers: () => [],
    getUploadUsage: () => ({ byUser: new Map() }),
    revokeBotVoiceAccess() {},
  });
  const stored = () => db.prepare("SELECT value FROM server_settings WHERE key = 'published_themes'").get()?.value;
  const publish = value => handlers.get('update-server-setting')({ key: 'published_themes', value });
  return { db, publish, outgoing, broadcasts, stored };
}

test('a member without Manage Server cannot publish a theme', t => {
  const h = publishHarness();
  t.after(() => h.db.close());
  h.publish('["braid.theme.css"]');
  assert.equal(h.stored(), undefined);
  assert.match(h.outgoing.at(-1).payload, /Only admins/);
  assert.equal(h.broadcasts.length, 0);
});

test('Manage Server can publish and take back a theme, and everyone is told', t => {
  const h = publishHarness({ manageServer: true });
  t.after(() => h.db.close());
  h.publish('["braid.theme.css"]');
  assert.equal(h.stored(), '["braid.theme.css"]');
  assert.deepEqual(
    h.broadcasts.find(b => b.event === 'server-setting-changed')?.payload,
    { key: 'published_themes', value: '["braid.theme.css"]' },
  );
  h.publish('[]');
  assert.equal(h.stored(), '[]');
});

test('the admin can publish bundled themes', t => {
  const h = publishHarness({ isAdmin: true });
  t.after(() => h.db.close());
  h.publish('["glassy-neon.theme.css","halloween.theme.css"]');
  assert.equal(h.stored(), '["glassy-neon.theme.css","halloween.theme.css"]');
});

// ── Wiring ─────────────────────────────────────────────────────────────

test('the app page loads the picker and keeps the theme-picker region', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  assert.match(html, /id="theme-selector"[^>]*data-haven-region="theme-picker"/);
  assert.ok(html.indexOf('/js/theme-gallery.js') < html.indexOf('/js/app.js'), 'the picker logic loads before the app');
  assert.match(appJs, /import ThemePickerMethods from '\.\/modules\/app-theme-picker\.js/);
  assert.match(appJs, /this\._setupThemes\(\);\s*this\._setupThemePicker\(\);/);
  assert.match(css, /@import url\('\/css\/style-theme-picker\.css/);
  // Layout stays in Settings, Layout; the theme menu has no layout picker.
  const popup = html.slice(html.indexOf('id="theme-popup"'), html.indexOf('<!-- Bottom bar -->'));
  assert.doesNotMatch(popup, /layout-picker|layout-select/);
});

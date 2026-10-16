'use strict';

/**
 * Members use Haven's own themes and the theme files an admin published.
 * The server refuses an unpublished file as a member's saved theme, apart
 * from the theme the account already has, so nobody loses their look.
 * People who manage the server can save any compatible file.
 *
 *   node --test test/themePublishGate.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const { themePreferenceAllowed } = require('../src/themeMetadata');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('themePreferenceAllowed: built-in and published themes are open to everyone', () => {
  assert.equal(themePreferenceAllowed('matrix'), true);
  assert.equal(themePreferenceAllowed('file:braid.theme.css', { published: ['braid.theme.css'] }), true);
  assert.equal(themePreferenceAllowed('file:braid.theme.css', { published: ['compact.theme.css'] }), false);
});

test('themePreferenceAllowed: an unpublished file is refused unless it is kept or the setter manages the server', () => {
  const file = 'file:braid.theme.css';
  assert.equal(themePreferenceAllowed(file), false, 'nothing published, nothing kept');
  assert.equal(themePreferenceAllowed(file, { current: file }), true, 'the account already has it');
  assert.equal(themePreferenceAllowed(file, { defaultTheme: file }), true, 'the server default');
  assert.equal(themePreferenceAllowed(file, { canManage: true }), true);
  assert.equal(themePreferenceAllowed(file, { canManage: 'yes' }), false, 'only a real true counts');
  assert.equal(themePreferenceAllowed(file, { published: 'braid.theme.css' }), false, 'a list, not a string');
});

test('the Settings list and the loader keep unpublished files from members', () => {
  const loader = read('public/js/plugin-loader.js');
  assert.match(loader, /function canUseUnpublished\(\)/);
  assert.match(loader, /window\.app\?\._canPublishThemes\?\.\(\) === true/, 'fails closed until the app knows the viewer');
  const enable = loader.slice(loader.indexOf('function enableTheme(file)'), loader.indexOf('function disableTheme(file)'));
  assert.match(enable, /if \(!isOffered\(file\)\) return;/);
  const select = loader.slice(loader.indexOf('function selectFileTheme(file)'), loader.indexOf('function applyFileTheme('));
  assert.match(select, /!isOffered\(file\) && !t\.enabled/);
  const render = loader.slice(loader.indexOf('function renderPluginUI()'), loader.indexOf('function escHtml('));
  assert.match(render, /\.filter\(\(\[file, record\]\) => isListed\(file, record\)\)/);
  assert.match(render, /settings\.plugins_section\.not_published/);
  assert.match(loader, /function onThemeRefused\(value\)/);
  const picker = read('public/js/modules/app-theme-picker.js');
  assert.match(picker, /'preference-refused'/);
  assert.match(picker, /_canPublishThemes\(\) \{\s+if \(!this\.user\) return false;/);
  const en = JSON.parse(read('public/locales/en.json'));
  assert.equal(typeof en.settings.plugins_section.not_published, 'string');
  assert.equal(typeof en.settings.plugins_section.theme_not_published, 'string');
});

const PORT = 3449;
const h = createHarness(PORT, 'theme-gate');

test('the server keeps unpublished theme files to admins and current picks', async (t) => {
  await h.start();

  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const mod = await h.register('mod');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const M = await h.connect(mod.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  // The database closes before the server stops, so its folder can go.
  t.after(() => { db.close(); h.stop(); });

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  const modRole = roles.find((r) => r.name === 'Mod');
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: modRole.id })).success);
  assert.ok((await h.ask(A, 'set-user-server-perm', { userId: mod.id, permission: 'manage_server', allowed: true })).success);
  await wait(100);

  const stored = (id) => db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'theme'").get(id)?.value;

  // Resolves 'saved' or 'refused', or null when the server says nothing.
  async function save(sock, value) {
    const saved = h.next(sock, 'preference-saved', (d) => d?.key === 'theme' && d.value === value, 1500);
    const refused = h.next(sock, 'preference-refused', (d) => d?.key === 'theme' && d.value === value, 1500);
    sock.emit('set-preference', { key: 'theme', value });
    return Promise.race([saved.then((d) => d && 'saved'), refused.then((d) => d && 'refused')]);
  }

  async function publish(list) {
    const changed = h.next(B, 'server-setting-changed', (d) => d?.key === 'published_themes');
    A.emit('update-server-setting', { key: 'published_themes', value: JSON.stringify(list) });
    assert.ok(await changed, 'the published list changed');
  }

  await t.test('a member cannot save an unpublished file, quietly', async () => {
    const errors = h.next(B, 'error-msg', () => true, 1500);
    assert.equal(await save(B, 'file:braid.theme.css'), 'refused');
    assert.equal(await errors, null, 'no error message');
    assert.equal(stored(bob.id), undefined);
  });

  await t.test('built-in themes are always saved', async () => {
    assert.equal(await save(B, 'matrix'), 'saved');
    assert.equal(stored(bob.id), 'matrix');
  });

  await t.test('a published file is saved', async () => {
    await publish(['braid.theme.css']);
    assert.equal(await save(B, 'file:braid.theme.css'), 'saved');
    assert.equal(stored(bob.id), 'file:braid.theme.css');
  });

  await t.test('a member keeps a theme that was unpublished after they picked it', async () => {
    await publish([]);
    assert.equal(await save(B, 'file:braid.theme.css'), 'saved', 'saving the current theme again works');
    assert.equal(stored(bob.id), 'file:braid.theme.css');
  });

  await t.test('once they pick another, the unpublished one is gone for them', async () => {
    assert.equal(await save(B, 'haven'), 'saved');
    assert.equal(await save(B, 'file:braid.theme.css'), 'refused');
    assert.equal(stored(bob.id), 'haven');
  });

  await t.test('the admin and Manage Server holders can save unpublished files', async () => {
    assert.equal(await save(A, 'file:compact.theme.css'), 'saved');
    assert.equal(await save(M, 'file:braid.theme.css'), 'saved');
    assert.equal(stored(mod.id), 'file:braid.theme.css');
  });

  await t.test('a malformed published list publishes nothing', async () => {
    db.prepare("UPDATE server_settings SET value = 'not json' WHERE key = 'published_themes'").run();
    assert.equal(await save(B, 'file:compact.theme.css'), 'refused');
    db.prepare("UPDATE server_settings SET value = '[]' WHERE key = 'published_themes'").run();
  });
});

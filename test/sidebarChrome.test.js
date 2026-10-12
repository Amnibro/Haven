'use strict';

/**
 * Sidebar chrome: what the static markup leaves to layout plugins.
 *
 *   node --test test/sidebarChrome.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const channels = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-channels.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-messages.js'), 'utf8');

test('static sidebar markup leaves layout chrome to the layout plugins', () => {
  const chrome = fs.readFileSync(path.join(ROOT, 'plugins/ChromeLayout.plugin.js'), 'utf8');
  for (const id of ['people-dock-btn', 'dm-dock-btn', 'channel-actions-btn', 'channel-actions-menu', 'home-server-menu', 'threads-toggle-badge']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
    assert.match(chrome, new RegExp(`'${id}'`));
  }
  assert.doesNotMatch(html, /channel-sheet-close|channel-action-sheet/);
  assert.equal((html.match(/id="dm-unread-badge"/g) || []).length, 1);
  assert.match(html, /id="admin-controls"[^>]*style="display:none"/);
  assert.doesNotMatch(html, /id="voice-join-btn"[^>]*hidden/);
});

test('Settings, Layout picks the layout and Original restores Haven chrome', () => {
  const theme = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');
  const themeInit = fs.readFileSync(path.join(ROOT, 'public/js/theme-init.js'), 'utf8');
  const voice = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-voice.js'), 'utf8');
  const braid = fs.readFileSync(path.join(ROOT, 'plugins/BraidLayout.plugin.js'), 'utf8');
  const section = html.slice(html.indexOf('id="section-layout"'));
  assert.match(section.slice(0, 2000), /id="layout-picker"/);
  assert.equal((html.match(/id="layout-picker"/g) || []).length, 1);
  assert.match(theme, /function _syncOriginalLayout/);
  assert.match(theme, /haven_original_layout/);
  assert.match(theme, /window\.havenLayoutWanted/);
  assert.doesNotMatch(theme, /haven:layout-effect|isHavenEffectActive/);
  assert.doesNotMatch(braid, /haven:layout-effect|isHavenEffectActive/);
  assert.match(braid, /window\.havenLayoutWanted\('BraidLayout'\)/);
  assert.match(themeInit, /data-haven-original-layout/);
  assert.match(css, /html\[data-haven-original-layout\] \.channel-join-voice/);
  assert.match(voice, /isHavenOriginalLayout/);
  assert.match(voice, /haven:original-layout/);
});

test('Braid tucks header extras and matches composer chips to the footer', () => {
  const braid = fs.readFileSync(path.join(ROOT, 'plugins/BraidLayout.plugin.js'), 'utf8');
  assert.match(braid, /#header-actions-box\{display:none!important\}/);
  assert.match(braid, /\.input-actions-box button[\s\S]*width:2\.5rem!important/);
  assert.match(braid, /\.message-input-area,\s*\nhtml\[data-braid-layout="1"\] \.message-input-container\{[^}]*padding:\.5rem \.625rem!important/);
  assert.match(braid, /#theme-popup-toggle,\s*\nhtml\[data-braid-layout="1"\] #activities-btn\{[^}]*width:2\.5rem!important;height:2\.5rem!important/);
  assert.match(braid, /not\(#people-dock-btn\):not\(#dm-dock-btn\):not\(#theme-popup-toggle\):not\(#activities-btn\)/);
  assert.match(braid, /haven_braid_people/);
  assert.match(braid, /server-icon\.add-server/);
  assert.match(braid, /#braid-voice-dock \.voice-bar\{display:flex/);
});

test('channel rows have a join-voice button', () => {
  assert.match(channels, /data-join-voice/);
  assert.match(channels, /channel-join-voice/);
  const voice = fs.readFileSync(path.join(ROOT, 'public/js/modules/app-voice.js'), 'utf8');
  assert.match(voice, /_syncChannelVoiceButtons\(/);
  assert.match(css, /\.channel-join-voice\s*\{/);
});

test('Braid message runs key on username, not only user id', () => {
  const braid = fs.readFileSync(path.join(ROOT, 'plugins/BraidLayout.plugin.js'), 'utf8');
  assert.match(braid, /dataset\.username/);
  assert.match(braid, /dataset\.webhookUsername/);
  assert.match(braid, /dataset\.importedFrom/);
  assert.match(messages, /dataset\.webhookUsername = msg\.webhook_username/);
  assert.doesNotMatch(braid, /\$\{el\.dataset\.userId \|\| '\?'\}\|\$\{el\.dataset\.personaId \|\| ''\}`/);
});

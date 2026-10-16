'use strict';

// Push to mute: hold a key in Haven Desktop and the mic is muted until it
// comes up. The rules are a small pure module; the app mixin is run here
// against a stand-in voice manager to check what reaches the mic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const load = async (p) => import(pathToFileURL(path.join(__dirname, '..', p)).href);

let createPushToMute;
let Methods;
test.before(async () => {
  ({ createPushToMute } = await load('public/js/modules/push-to-mute-state.js'));
  Methods = (await load('public/js/modules/app-push-to-mute.js')).default;
});

test('hold and release puts a live mic back live', () => {
  const ptm = createPushToMute();
  assert.equal(ptm.press(false), true, 'the press mutes a live mic');
  assert.equal(ptm.isHeld(), true);
  assert.equal(ptm.release({ isMuted: true }), 'unmute');
  assert.equal(ptm.isHeld(), false);
});

test('already muted stays muted', () => {
  const ptm = createPushToMute();
  assert.equal(ptm.press(true), false, 'nothing to mute');
  assert.equal(ptm.release({ isMuted: true }), null, 'the release does not unmute');
});

test('a second press from another path while held changes nothing', () => {
  const ptm = createPushToMute();
  ptm.press(false);
  assert.equal(ptm.press(true), false);
  assert.equal(ptm.release({ isMuted: true }), 'unmute', 'the first press decides');
  assert.equal(ptm.release({ isMuted: false }), null, 'a second release is ignored');
});

test('push to talk while push to mute is held: mute wins, and the release follows push to talk', () => {
  // Haven in push to talk mode: muted, then the talk key goes down while
  // push to mute is held.
  const ptm = createPushToMute();
  ptm.press(true);
  assert.equal(ptm.toggle(), true, 'the talk press is taken while held');
  assert.equal(ptm.userMuted(true), false, 'push to talk wants the mic open');
  assert.equal(ptm.release({ isMuted: true }), 'unmute', 'still talking when push to mute comes up');

  // Talk key released before push to mute.
  const again = createPushToMute();
  again.press(true);
  again.toggle();
  again.toggle();
  assert.equal(again.release({ isMuted: true }), null, 'talk key already up: stays muted');

  // Talking first, then push to mute.
  const first = createPushToMute();
  assert.equal(first.press(false), true, 'mute wins over a held talk key');
  first.toggle(); // talk key comes up while held
  assert.equal(first.release({ isMuted: true }), null);
});

test('a toggle with nothing held is left to the caller', () => {
  const ptm = createPushToMute();
  assert.equal(ptm.toggle(), false);
  assert.equal(ptm.userMuted(true), true);
  assert.equal(ptm.userMuted(false), false);
});

test('deafened while held: the mic stays muted with the deafen', () => {
  const ptm = createPushToMute();
  ptm.press(false);
  assert.equal(ptm.release({ isMuted: true, isDeafened: true }), 'stay-deafened');
});

// ── The app mixin against a stand-in voice manager ──

function makeApp({ isMuted = false, inVoice = true } = {}) {
  const emitted = [];
  const sounds = [];
  const track = { enabled: !isMuted };
  const voice = {
    isMuted, isDeafened: false, inVoice, currentChannel: inVoice ? 'abc' : null,
    isListenerOnly: false, _voiceSessionGeneration: 1,
    toggleMute() { this.isMuted = !this.isMuted; track.enabled = !this.isMuted; return this.isMuted; },
  };
  const app = Object.assign(Object.create(null), Methods, {
    voice, track, emitted, sounds,
    socket: { emit: (name, data) => emitted.push([name, data]) },
    notifications: { playDirect: (tone) => sounds.push(tone) },
    _syncMuteDeafenButtons() {},
    _updateVoiceBar() {},
  });
  // The mute button, as app-voice.js has it (the deafen branch left out).
  app._toggleMute = function () {
    if (this._pushToMuteTakesToggle()) return;
    const muted = this.voice.toggleMute();
    this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted });
  };
  return app;
}

test('the app silences the outgoing track while held and restores it after', () => {
  const app = makeApp();
  app._pushToMute(true);
  assert.equal(app.track.enabled, false);
  assert.equal(app._pushToMuteHeld(), true);
  app._pushToMute(true); // the hook and the page both saw the press
  app._pushToMute(false);
  assert.equal(app.track.enabled, true);
  assert.equal(app.voice.isMuted, false);
  assert.deepEqual(app.emitted.map(e => e[1].muted), [true, false], 'one mute state each way, as push to talk sends');
  assert.deepEqual(app.sounds, ['mute_on', 'mute_off']);
});

test('the app leaves a muted mic muted', () => {
  const app = makeApp({ isMuted: true });
  app._pushToMute(true);
  app._pushToMute(false);
  assert.equal(app.voice.isMuted, true);
  assert.equal(app.track.enabled, false);
  assert.equal(app.emitted.length, 0);
});

test('push to talk through the mute toggle while held never opens the mic', () => {
  const app = makeApp({ isMuted: true });
  app._pushToMute(true);
  // What Haven Desktop does on a talk press: reads the user's own mute and
  // toggles when it has to change.
  assert.equal(app._micUserMuted(), true);
  app._toggleMute();
  assert.equal(app.voice.isMuted, true, 'mute wins');
  assert.equal(app.track.enabled, false);
  assert.equal(app._micUserMuted(), false);
  app._toggleMute(); // talk key up
  app._pushToMute(false);
  assert.equal(app.voice.isMuted, true, 'back to push to talk at rest');
});

test('out of voice the key does nothing, and a session change drops a held key', () => {
  const out = makeApp({ inVoice: false });
  out._pushToMute(true);
  out._pushToMute(false);
  assert.equal(out.voice.isMuted, false);
  assert.equal(out.emitted.length, 0);

  const app = makeApp();
  app._pushToMute(true);
  app.voice._voiceSessionGeneration = 2; // left and joined again, key still down
  app._pushToMute(false);
  assert.equal(app.voice.isMuted, true, 'a release never unmutes a session it did not mute');
});

test('the app loads the mixin and the mute paths ask it first', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import PushToMuteMethods from '\.\/modules\/app-push-to-mute\.js\?v=[0-9.]+';/);
  assert.match(app, /^\s*PushToMuteMethods,$/m);
  const voice = read('public/js/modules/app-voice.js');
  assert.match(voice, /_toggleMute\(\) \{\n[^\n]*\n[^\n]*\n\s*if \(this\._pushToMuteTakesToggle\?\.\(\)\) return;/);
  assert.match(voice, /btn\.classList\.toggle\('ptm-held', ptmHeld\)/);
  const html = read('public/app.html');
  assert.match(html, /id="shortcut-row-ptm"/);
  assert.match(html, /data-action="ptm"/);
  const en = JSON.parse(read('public/locales/en.json'));
  for (const key of ['ptm', 'ptm_hint']) assert.ok(en.settings.desktop_shortcuts_section[key], key);
  for (const key of ['push_to_mute_held', 'status_push_to_mute']) assert.ok(en.voice[key], key);
});

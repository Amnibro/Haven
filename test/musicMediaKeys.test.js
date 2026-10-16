'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-music-keys.js'), 'utf8');

function load(globals = {}) {
  const context = vm.createContext({ module: { exports: {} }, t: key => key, console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-music-keys.js' });
  return context.module.exports;
}

const methods = load();

function state(over = {}) {
  return {
    inVoice: true, active: true, playing: true, canControl: true,
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', queueLength: 0, soundCloudTracks: 0, pausedAt: 0,
    ...over,
  };
}

const plan = (action, over) => methods._musicMediaKeyPlan(action, state(over));

test('play and pause keys follow the shared play state', () => {
  assert.equal(plan('playpause'), 'pause');
  assert.equal(plan('playpause', { playing: false }), 'play');
  assert.equal(plan('play'), null);
  assert.equal(plan('play', { playing: false }), 'play');
  assert.equal(plan('pause'), 'pause');
  assert.equal(plan('pause', { playing: false }), null);
});

test('next follows the Next button and previous restarts or goes back', () => {
  assert.equal(plan('nexttrack'), null, 'a lone YouTube video with nothing queued has no next');
  assert.equal(plan('nexttrack', { queueLength: 2 }), 'next');
  assert.equal(plan('nexttrack', { url: 'https://soundcloud.com/a/b' }), 'next');
  assert.equal(plan('previoustrack'), 'restart');
  assert.equal(plan('previoustrack', { url: 'https://soundcloud.com/a/sets/b', soundCloudTracks: 5 }), 'prev');
  assert.equal(plan('previoustrack', { url: 'https://soundcloud.com/a/b', soundCloudTracks: 1 }), 'restart');
  assert.equal(plan('stop'), null);
  assert.equal(plan('seekto'), null);
});

test('keys do nothing for someone who could not click the controls', () => {
  for (const action of ['play', 'pause', 'playpause', 'nexttrack', 'previoustrack']) {
    assert.equal(plan(action, { canControl: false, queueLength: 3 }), null, action);
    assert.equal(plan(action, { inVoice: false, queueLength: 3 }), null, action);
    assert.equal(plan(action, { active: false, queueLength: 3 }), null, action);
    assert.equal(plan(action, { url: 'https://open.spotify.com/track/abc', queueLength: 3 }), null, `spotify ${action}`);
  }
  assert.equal(methods._musicMediaKeyPlan('playpause', null), null);
});

test('Desktop holds the keys while playing and for a while after a pause', () => {
  const now = 10_000_000;
  const wanted = (over) => methods._musicMediaKeysWanted(state(over), now);
  assert.equal(wanted(), true);
  assert.equal(wanted({ playing: false, pausedAt: now - 60_000 }), true);
  assert.equal(wanted({ playing: false, pausedAt: now - 6 * 60_000 }), false);
  assert.equal(wanted({ playing: false, pausedAt: 0 }), false);
  assert.equal(wanted({ canControl: false }), false);
  assert.equal(wanted({ url: 'https://open.spotify.com/track/abc' }), false);
  assert.equal(wanted({ active: false }), false);
});

function fakeApp(over = {}) {
  const calls = [];
  const app = Object.assign(Object.create(null), methods, {
    voice: { inVoice: true },
    _musicActive: true,
    _musicPlaying: true,
    _musicUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    _musicQueue: [],
    _canControlMusic() { return true; },
    _toggleMusicPlayPause() { calls.push('toggle'); this._musicPlaying = !this._musicPlaying; },
    _musicTrackControl(action) { calls.push(action); },
    _suppressMusicBroadcasts() {},
    _seekMusicToSeconds(s) { calls.push(`seek:${s}`); },
    _withMusicDuration(cb) { cb(200); },
    _emitMusicSeek(pos, dur) { calls.push(`emitSeek:${pos}/${dur}`); },
    _setMusicActivityHint() {},
  }, over);
  return { app, calls };
}

test('a press runs the same control as the button', () => {
  const { app, calls } = fakeApp({ _musicQueue: [{ id: 'x' }] });
  assert.equal(app._musicMediaKey('playpause'), true);
  assert.equal(app._musicMediaKey('play'), true);
  assert.equal(app._musicMediaKey('play'), false, 'already playing');
  assert.equal(app._musicMediaKey('nexttrack'), true);
  assert.equal(app._musicMediaKey('previoustrack'), true);
  assert.deepEqual(calls, ['toggle', 'toggle', 'next', 'seek:0', 'emitSeek:0/200']);
});

test('a press after losing control of the player does nothing', () => {
  const { app, calls } = fakeApp({ _canControlMusic() { return false; } });
  for (const action of ['playpause', 'nexttrack', 'previoustrack']) assert.equal(app._musicMediaKey(action), false);
  assert.deepEqual(calls, []);
});

test('the page asks Desktop for the keys only when they change hands, and sets the media session', () => {
  const events = [];
  const handlers = {};
  const session = {
    metadata: 'untouched', playbackState: 'none',
    setActionHandler(action, fn) { handlers[action] = fn; },
  };
  const document = { pictureInPictureElement: null, dispatchEvent(e) { events.push(e.detail.wanted); } };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  class MediaMetadata { constructor(init) { Object.assign(this, init); } }
  const m = load({ navigator: { mediaSession: session }, document, CustomEvent, MediaMetadata });
  const calls = [];
  const app = Object.assign(Object.create(null), m, {
    voice: { inVoice: true }, _musicActive: true, _musicPlaying: true,
    _musicUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', _musicQueue: [], _musicTitle: 'Song', _musicRequestorName: 'bob',
    _canControlMusic() { return true; },
    _toggleMusicPlayPause() { calls.push('toggle'); },
  });
  app._syncMusicMediaKeys();
  app._syncMusicMediaKeys();
  assert.deepEqual(events, [true], 'one claim, not one per change');
  assert.equal(session.metadata.title, 'Song');
  assert.equal(session.metadata.artist, 'bob');
  assert.equal(session.playbackState, 'playing');
  assert.equal(typeof handlers.pause, 'function');
  assert.equal(handlers.nexttrack, null, 'no Next with nothing queued');
  handlers.pause();
  assert.deepEqual(calls, ['toggle']);

  // Paused: the claim stays for the grace period.
  app._musicPlaying = false;
  app._syncMusicMediaKeys();
  assert.deepEqual(events, [true]);
  assert.equal(session.playbackState, 'paused');
  clearTimeout(app._musicKeysGraceTimer);

  // Losing control lets go of the keys and the media session.
  app._canControlMusic = () => false;
  app._syncMusicMediaKeys();
  assert.deepEqual(events, [true, false]);
  assert.equal(session.metadata, null);
  assert.equal(handlers.play, null);
  assert.equal(handlers.pause, null);
  assert.equal(app._musicKeysGraceTimer, null);
});

test('a paused player lets go of the keys when the grace period ends', () => {
  const events = [];
  const document = { pictureInPictureElement: null, dispatchEvent(e) { events.push(e.detail.wanted); } };
  class CustomEvent { constructor(type, init) { this.detail = init.detail; } }
  const timers = [];
  const m = load({ document, CustomEvent, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
  const app = Object.assign(Object.create(null), m, {
    voice: { inVoice: true }, _musicActive: true, _musicPlaying: false,
    _musicUrl: 'https://soundcloud.com/a/b', _musicQueue: [], _musicPausedAt: Date.now() - 1000,
    _canControlMusic() { return true; },
  });
  app._syncMusicMediaKeys();
  assert.deepEqual(events, [true]);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms > 4 * 60_000 && timers[0].ms <= 5 * 60_000 + 50);
  app._musicPausedAt = Date.now() - 6 * 60_000;
  timers[0].fn();
  assert.deepEqual(events, [true, false]);
});

test('Listen Together calls the media key sync wherever the player changes', () => {
  const music = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-music.js'), 'utf8');
  for (const fn of ['_applyMusicControlPermissions', '_updateMusicQueueState', '_setMusicPlayingUi', '_hideMusicPanel']) {
    const start = music.indexOf(`\n${fn}(`);
    assert.ok(start > 0, fn);
    const end = music.indexOf('\n},', start);
    assert.match(music.slice(start, end), /this\._syncMusicMediaKeys\(\);/, fn);
  }
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  assert.match(appJs, /import MusicKeyMethods from '\.\/modules\/app-music-keys\.js\?v=/);
  assert.match(appJs, /\n {2}MusicKeyMethods,\n/);
});

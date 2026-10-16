// Media keys for Listen Together. The keyboard's play/pause, next and
// previous keys, the system media overlay (through the Media Session API)
// and Haven Desktop's global media keys all run the shared player's own
// controls, and only the ones this user could click: the person who queued
// the track, admins and members with manage_music_queue.
//
// Haven Desktop takes the media keys away from other apps, so it is only
// asked to while the shared player is playing, or paused for less than
// MUSIC_KEYS_PAUSE_GRACE_MS (so Play still resumes it), and only for someone
// allowed to control it. The page tells it through the haven:music-media-keys
// event, and Desktop sends each press back to _musicMediaKey.

const MUSIC_KEYS_PAUSE_GRACE_MS = 5 * 60 * 1000;
const MUSIC_SESSION_ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack'];

export default {

_musicMediaKeyState() {
  return {
    inVoice: !!(this.voice && this.voice.inVoice),
    active: !!this._musicActive,
    playing: !!this._musicPlaying,
    canControl: !!this._canControlMusic(),
    url: this._musicUrl || '',
    queueLength: Array.isArray(this._musicQueue) ? this._musicQueue.length : 0,
    soundCloudTracks: this._musicSCTrackCount || 0,
    pausedAt: this._musicPausedAt || 0,
  };
},

// What a media key does to the shared player: 'play', 'pause', 'next',
// 'prev', 'restart', or null when the user could not do it by clicking.
// Next follows the Next button (a SoundCloud set, or something queued).
// Previous goes back a track in a SoundCloud set and otherwise restarts the
// track, which is what the seek bar can do. Spotify has no controls Haven can
// drive, so its keys stay with the embed.
_musicMediaKeyPlan(action, state) {
  if (!state || !state.inVoice || !state.active || !state.canControl) return null;
  const url = String(state.url || '');
  if (url.includes('spotify.com')) return null;
  const isSoundCloud = url.includes('soundcloud.com');
  switch (action) {
    case 'play': return state.playing ? null : 'play';
    case 'pause': return state.playing ? 'pause' : null;
    case 'playpause': return state.playing ? 'pause' : 'play';
    case 'nexttrack': return (isSoundCloud || state.queueLength > 0) ? 'next' : null;
    case 'previoustrack': return (isSoundCloud && state.soundCloudTracks > 1) ? 'prev' : 'restart';
    default: return null;
  }
},

// Whether Haven Desktop should hold the media keys right now.
_musicMediaKeysWanted(state, now) {
  if (!this._musicMediaKeyPlan('playpause', state)) return false;
  if (state.playing) return true;
  return state.pausedAt > 0 && now - state.pausedAt < MUSIC_KEYS_PAUSE_GRACE_MS;
},

// One press of a media key, from the Media Session or from Haven Desktop.
// The plan is worked out again here, so a press that arrives after the
// user lost control of the player does nothing.
_musicMediaKey(action) {
  const plan = this._musicMediaKeyPlan(action, this._musicMediaKeyState());
  if (!plan) return false;
  if (plan === 'play' || plan === 'pause') {
    this._toggleMusicPlayPause();
  } else if (plan === 'next' || plan === 'prev') {
    this._musicTrackControl(plan);
  } else if (plan === 'restart') {
    this._suppressMusicBroadcasts();
    this._seekMusicToSeconds(0);
    this._withMusicDuration((durationSeconds) => this._emitMusicSeek(0, durationSeconds));
    this._setMusicActivityHint(t('media.music_seeked'));
  }
  return true;
},

// Called whenever the player, its play state, the queue or the user's
// control of it changes.
_syncMusicMediaKeys() {
  const now = Date.now();
  if (!this._musicActive || this._musicPlaying) this._musicPausedAt = 0;
  else if (!this._musicPausedAt) this._musicPausedAt = now;
  const state = this._musicMediaKeyState();
  const wanted = this._musicMediaKeysWanted(state, now);

  if (wanted !== !!this._musicKeysClaimed) {
    this._musicKeysClaimed = wanted;
    document.dispatchEvent(new CustomEvent('haven:music-media-keys', { detail: { wanted } }));
  }
  // Let go of the keys once a pause has lasted the whole grace period.
  if (this._musicKeysGraceTimer) {
    clearTimeout(this._musicKeysGraceTimer);
    this._musicKeysGraceTimer = null;
  }
  if (wanted && !state.playing) {
    const left = Math.max(0, MUSIC_KEYS_PAUSE_GRACE_MS - (now - state.pausedAt));
    this._musicKeysGraceTimer = setTimeout(() => {
      this._musicKeysGraceTimer = null;
      this._syncMusicMediaKeys();
    }, left + 50);
  }
  this._syncMusicMediaSession(state);
},

// The page's Media Session: the system media overlay shows the track, and
// its buttons and the media keys run the same controls. A video from chat
// in picture in picture owns the session while it is open
// (app-link-previews.js), and hands it back when it closes.
_syncMusicMediaSession(state) {
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  if (!session || typeof session.setActionHandler !== 'function') return;
  if (typeof document !== 'undefined' && document.pictureInPictureElement) return;

  const on = !!this._musicMediaKeyPlan('playpause', state);
  if (!on && !this._musicSessionOwned) return;
  this._musicSessionOwned = on;
  this._musicMediaHandlers = {};
  for (const action of MUSIC_SESSION_ACTIONS) {
    // Next is only offered when the Next button would be shown.
    const offered = on && (action !== 'nexttrack' || !!this._musicMediaKeyPlan(action, state));
    const handler = offered ? () => { this._musicMediaKey(action); } : null;
    if (handler) this._musicMediaHandlers[action] = handler;
    try {
      session.setActionHandler(action, handler);
    } catch (err) {
      // An action this browser does not have: that key is just not offered.
      console.warn(`[music] media session has no "${action}" action:`, err.message);
    }
  }
  if (on) {
    if (typeof MediaMetadata === 'function') {
      session.metadata = new MediaMetadata({
        title: this._musicTitle || t('voice.music'),
        artist: this._musicRequestorName || '',
        album: 'Haven',
      });
    }
    session.playbackState = state.playing ? 'playing' : 'paused';
  } else {
    session.metadata = null;
    session.playbackState = 'none';
  }
},

};

// Push to mute from Haven Desktop: hold a key and the mic goes quiet until it
// comes up. People bind it to a game's own push to talk key, so Haven stays
// on an open mic for friends and goes silent while they talk in the game.
// Desktop calls _pushToMute(true / false) on press and release; the mute
// rules themselves are in push-to-mute-state.js.

import { createPushToMute } from './push-to-mute-state.js?v=4.24.5';

export default {

// The state for the voice session in progress. A held key from an earlier
// session (left voice, or moved to another channel) is dropped, so its
// release can never unmute a session it did not mute.
_pushToMuteCurrent() {
  if (!this._ptm) this._ptm = createPushToMute();
  const session = this.voice ? this.voice._voiceSessionGeneration : null;
  if (this._ptmSession !== session) {
    this._ptm.reset();
    this._ptmSession = session;
  }
  return this._ptm;
},

_pushToMuteHeld() {
  return !!(this.voice && this.voice.inVoice) && this._pushToMuteCurrent().isHeld();
},

/** The user's own mute, which is what comes back when the key is released. */
_micUserMuted() {
  return this._pushToMuteCurrent().userMuted(this.voice && this.voice.isMuted);
},

/** Hold (true) or release (false) push to mute. */
_pushToMute(held) {
  const voice = this.voice;
  const inVoice = !!(voice && voice.inVoice);
  const ptm = this._pushToMuteCurrent();
  if (held) {
    if (!inVoice) return;
    if (ptm.press(voice.isMuted)) this._setMicMuted(true);
  } else {
    if (!ptm.isHeld()) return;
    if (!inVoice) { ptm.reset(); return; }
    const outcome = ptm.release({ isMuted: voice.isMuted, isDeafened: voice.isDeafened });
    if (outcome === 'unmute') this._setMicMuted(false);
    // Deafened while the key was down: the mic stays muted with the deafen,
    // and undeafening gives it back, as if the deafen had muted it.
    else if (outcome === 'stay-deafened') this._mutedByDeafen = true;
  }
  this._syncMuteDeafenButtons();
  this._updateVoiceBar();
},

/**
 * A mute toggle (mute button, push to talk) while push to mute is held only
 * changes what comes back on release. Returns true when it was taken here.
 */
_pushToMuteTakesToggle() {
  if (!this._pushToMuteHeld()) return false;
  this._pushToMuteCurrent().toggle();
  this._syncMuteDeafenButtons();
  this._updateVoiceBar();
  return true;
},

// Mutes or unmutes the mic the way the mute button does: the tracks, the
// cue tone and the mute state everyone in the channel sees, which is also
// what push to talk sends on each press.
_setMicMuted(muted) {
  if (!!this.voice.isMuted === muted) return;
  const now = this.voice.toggleMute();
  this.notifications.playDirect(now ? 'mute_on' : 'mute_off');
  if (this.voice.currentChannel) {
    this.socket.emit('voice-mute-state', { code: this.voice.currentChannel, muted: now });
  }
},

};

// Push to mute: hold a key and the mic is silent until the key comes up.
//
// The mic's mute (voice.isMuted) always says what is going out, so the
// tracks, the talk indicator and what other people see all follow it with no
// changes of their own. While the key is held, this keeps what the user's own
// mute would be, so releasing the key puts back exactly that:
//   - live before the press: live again after;
//   - muted before the press: still muted after;
//   - a mute toggle while held (the mute button, push to talk) changes only
//     what comes back on release, so mute always wins while the key is down.
//
// Pure state with no DOM or socket, so it can be tested on its own.

export function createPushToMute() {
  let held = false;
  let userMuted = false;

  return {
    isHeld() { return held; },

    /** What the user's own mute is: their choice while held, else the mic's. */
    userMuted(isMuted) { return held ? userMuted : !!isMuted; },

    /**
     * The key went down. Returns true when the mic has to be muted now,
     * false when it is already muted or the key was already down.
     */
    press(isMuted) {
      if (held) return false;
      held = true;
      userMuted = !!isMuted;
      return !isMuted;
    },

    /**
     * A mute toggle while the key is down. Returns false when the key is not
     * held, so the caller toggles the mic as usual; true when it was taken
     * here as the user's choice for after the release.
     */
    toggle() {
      if (!held) return false;
      userMuted = !userMuted;
      return true;
    },

    /**
     * The key came up. Returns what the mic should become:
     *   'unmute'          the user was live, so go live again;
     *   'stay-deafened'   the user was live but deafened themselves while
     *                     holding the key, so the mic stays muted with the
     *                     deafen, the way deafening always mutes it;
     *   null              nothing to change.
     */
    release({ isMuted, isDeafened } = {}) {
      if (!held) return null;
      held = false;
      if (userMuted || !isMuted) return null;
      return isDeafened ? 'stay-deafened' : 'unmute';
    },

    /** Forget a held key, for leaving voice. */
    reset() { held = false; userMuted = false; },
  };
}

// Playing media in chat: the volume of YouTube cards, and pausing media
// scrolled out of view.
//
// YouTube's embedded player shows only a mute button on narrow and Shorts
// layouts, so the card's top bar gets its own volume slider. It drives the
// player through YouTube's iframe API (the card loads with enablejsapi) and
// is remembered for every card on this device.
//
// "Pause videos and audio scrolled out of view" (Settings > Link Previews,
// on by default): a video, an audio file or a YouTube card in the channel,
// a thread or the DM pop-out stops when it leaves the screen. A video popped
// out into the browser's own picture-in-picture keeps playing, and so does one
// pinned with its 📌 Keep playing button (until the page reloads).

const VOLUME_KEY = 'haven_embed_volume';
const PAUSE_KEY = 'haven_pause_offscreen_media';
const FEEDS = ['messages', 'thread-messages', 'dm-pip-messages'];
const MEDIA = 'video, audio, .link-preview-yt iframe';

export default {

_embedVolume() {
  let v = NaN;
  try { v = parseInt(localStorage.getItem(VOLUME_KEY) || '', 10); } catch { /* private mode: no saved volume, use the default */ }
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100;
},

_ytCommand(iframe, func, args = []) {
  try {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
  } catch (err) {
    console.warn('[media] could not reach the YouTube player', err.message);
  }
},

// The slider for a YouTube card's top bar, its Loop button and its Keep
// playing pin.
_ytVolumeHtml() {
  const v = this._embedVolume();
  return `<label class="lp-volume" title="${t('app.messages.embed_volume')}"><span aria-hidden="true">${v === 0 ? '🔇' : '🔊'}</span><input type="range" min="0" max="100" step="5" value="${v}" aria-label="${t('app.messages.embed_volume')}"></label>${this._loopHtml()}${this._keepPlayingHtml()}`;
},

// YouTube's player cannot be set to loop from outside once it is loaded, so
// a looping card asks the player to report its state and starts the video
// over when it says it ended. A player only reports to a page that said it
// is listening; that is asked again on every toggle, which is harmless.
_ytListen(iframe) {
  try {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube.com');
  } catch (err) {
    console.warn('[media] could not reach the YouTube player', err.message);
  }
  this._ytCommand(iframe, 'addEventListener', ['onStateChange']);
},

_ytLoopOnEnd(e) {
  if (e.origin !== 'https://www.youtube.com' || typeof e.data !== 'string') return;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; /* not one of the player's messages */ }
  const ended = (msg.event === 'onStateChange' && msg.info === 0)
    || (msg.event === 'infoDelivery' && msg.info && msg.info.playerState === 0);
  if (!ended) return;
  const iframe = [...document.querySelectorAll('.link-preview-yt iframe[data-loop="1"]')].find(f => f.contentWindow === e.source);
  if (!iframe) return;
  this._ytCommand(iframe, 'seekTo', [0, true]);
  this._ytCommand(iframe, 'playVideo');
},

// A pin that lets one video, sound or YouTube card keep playing when it is
// scrolled out of view. It shows only while that pausing is switched on.
_keepPlayingHtml() {
  return `<button type="button" class="media-keep" aria-pressed="false" title="${t('app.messages.keep_playing')}" aria-label="${t('app.messages.keep_playing')}">📌</button>`;
},

// Loop for an uploaded video or sound (#5817). The browser's own controls
// keep Loop in the right-click menu only, which a phone never shows.
_loopHtml() {
  return `<button type="button" class="media-loop" aria-pressed="false" title="${t('app.messages.loop')}" aria-label="${t('app.messages.loop')}">🔁</button>`;
},

// The player a pin belongs to: the one in its own file card or YouTube card.
_keepPlayingTarget(btn) {
  const box = btn.closest('.link-preview, .file-attachment');
  return box ? box.querySelector('video, audio, .link-preview-yt iframe') : null;
},

_wireYtVolume(card) {
  const slider = card.querySelector('.lp-volume input');
  const icon = card.querySelector('.lp-volume span');
  const iframe = card.querySelector('.link-preview-yt iframe');
  if (!slider || !iframe) return;
  const apply = (v) => {
    this._ytCommand(iframe, 'setVolume', [v]);
    this._ytCommand(iframe, v === 0 ? 'mute' : 'unMute');
  };
  // The header is a click target of its own (size, collapse): keep the
  // slider's clicks to itself.
  slider.addEventListener('click', (e) => e.stopPropagation());
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    if (icon) icon.textContent = v === 0 ? '🔇' : '🔊';
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* private mode: the volume lasts this visit only */ }
    apply(v);
  });
  // The player takes commands once it has started up; until then they are
  // dropped, so the saved volume is sent a few times after it loads.
  iframe.addEventListener('load', () => {
    const v = this._embedVolume();
    if (v === 100) return;
    for (const ms of [400, 1500, 4000]) setTimeout(() => apply(this._embedVolume()), ms);
  });
},

_pauseOffscreenOn() {
  // On unless turned off.
  try { return localStorage.getItem(PAUSE_KEY) !== 'false'; } catch { return true; }
},

_setupMediaPlayback() {
  // The pins show only while pausing is on (style-streams-markdown.css).
  const showPins = () => document.body.classList.toggle('pause-offscreen-off', !this._pauseOffscreenOn());
  showPins();
  const toggle = document.getElementById('pause-offscreen-media');
  if (toggle) {
    toggle.checked = this._pauseOffscreenOn();
    toggle.addEventListener('change', () => {
      try { localStorage.setItem(PAUSE_KEY, toggle.checked ? 'true' : 'false'); } catch { /* private mode: the choice lasts this visit only */ }
      showPins();
    });
  }
  this._keepPlaying = new WeakSet();
  // Card headers are click targets of their own (size, collapse), so the
  // pin keeps its clicks to itself.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.media-keep');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const media = this._keepPlayingTarget(btn);
    if (!media) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.title = t(on ? 'app.messages.keep_playing_on' : 'app.messages.keep_playing');
    if (on) this._keepPlaying.add(media); else this._keepPlaying.delete(media);
  }, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.media-loop');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const box = btn.closest('.file-attachment, .link-preview');
    const media = box?.querySelector('video, audio');
    const iframe = media ? null : box?.querySelector('.link-preview-yt iframe');
    if (!media && !iframe) return;
    let on;
    if (media) {
      media.loop = !media.loop;
      on = media.loop;
    } else {
      on = iframe.dataset.loop !== '1';
      if (on) { iframe.dataset.loop = '1'; this._ytListen(iframe); } else delete iframe.dataset.loop;
    }
    btn.setAttribute('aria-pressed', String(on));
    btn.title = t(on ? 'app.messages.loop_on' : 'app.messages.loop');
  }, true);
  window.addEventListener('message', (e) => this._ytLoopOnEnd(e));
  if (typeof IntersectionObserver !== 'function') return;
  const seen = new WeakSet();
  const io = new IntersectionObserver((entries) => {
    if (!this._pauseOffscreenOn()) return;
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const el = entry.target;
      if (this._keepPlaying.has(el)) continue;
      if (el.tagName === 'IFRAME') this._ytCommand(el, 'pauseVideo');
      else if (!el.paused && document.pictureInPictureElement !== el) el.pause();
    }
  });
  const watch = (root) => {
    if (!root || !root.querySelectorAll) return;
    const found = root.matches?.(MEDIA) ? [root] : [];
    found.push(...root.querySelectorAll(MEDIA));
    for (const el of found) {
      if (seen.has(el)) continue;
      seen.add(el);
      io.observe(el);
    }
  };
  for (const id of FEEDS) {
    const feed = document.getElementById(id);
    if (!feed) continue;
    watch(feed);
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(n => { if (n.nodeType === 1) watch(n); });
    }).observe(feed, { childList: true, subtree: true });
  }
},

};

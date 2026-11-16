// Offline use. When the connection to the server drops (laptop off the
// Wi-Fi, server restarting, LAN box rebooting) the loaded app stays usable:
// a banner says it is offline and reconnecting (socket.io retries with
// backoff on its own), channels already on screen stay readable, and
// messages written meanwhile wait in an outbox, shown as pending, and go out
// in order, once each, as soon as the connection is back. The service worker
// (public/sw.js) keeps the app shell so a reload while offline opens the app
// rather than the browser's error page.
//
// The outbox lives in memory for this page only. Nothing is written to
// storage, so a queued message (or a DM, already encrypted when queued)
// never outlives the tab on a shared device.

const MAX_OUTBOX = 200;

export default {

// Only the socket decides. navigator.onLine can read false on a LAN with no
// internet even while the server is right there.
_isOffline() {
  return !this.socket || !this.socket.connected;
},

// Register the service worker for the offline shell. The push code registers
// the same script later; registering twice is harmless.
_setupOfflineShell() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(reg => {
    // Hand the worker everything this page loaded so a reload while the
    // server is down opens the app; it keeps only static shell paths.
    const urls = [location.origin + '/app'].concat(performance.getEntriesByType('resource')
      .map(e => e.name).filter(u => u.startsWith(location.origin + '/')));
    reg.active?.postMessage({ type: 'cache-shell', urls });
  }).catch(err => {
    console.warn('[Offline] service worker not registered, no offline shell:', err && err.message);
  });
},

_setupOffline() {
  this._outbox = [];
  this._setupOfflineShell();
  // Show the banner only after a short grace period, so a sub-second blip
  // during a normal reconnect does not flash it.
  const update = () => {
    clearTimeout(this._offlineBannerTimer);
    if (this._isOffline()) this._offlineBannerTimer = setTimeout(() => this._renderOfflineBanner(), 1500);
    else this._renderOfflineBanner();
  };
  this.socket.on('disconnect', update);
  this.socket.on('connect_error', update);
  this.socket.on('connect', () => { update(); this._flushOutbox(); });
  // The OS says the network went away. A socket can look connected for
  // another 20 s or so before its pings time out, and anything sent into it
  // meanwhile is lost, so test it now: reconnecting either works at once
  // (the LAN is still there) or leaves it disconnected, and messages queue.
  // Not during a call, where the voice code handles its own recovery.
  window.addEventListener('offline', () => {
    if (this.socket?.connected && !this.voice?.inVoice) {
      try { this.socket.disconnect(); this.socket.connect(); } catch { /* socket.io retries */ }
    }
    update();
  });
  window.addEventListener('online', () => {
    update();
    // The OS says the network is back: do not wait out socket.io's backoff.
    // If the socket rode out the drop, what was queued goes now.
    if (this.socket && this.socket.connected) this._flushOutbox();
    else if (this.socket) { try { this.socket.connect(); } catch { /* retried by socket.io */ } }
  });
},

_renderOfflineBanner() {
  let el = document.getElementById('offline-banner');
  const offline = this._isOffline();
  if (!offline) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'offline-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:100000;' +
      'padding:6px 14px;border-radius:6px;background:#b3261e;color:#fff;font-size:13px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none;max-width:calc(100vw - 32px);text-align:center';
    document.body.appendChild(el);
  }
  const n = (this._outbox || []).length;
  el.textContent = t('app.offline.banner') + (n ? ' ' + t('app.offline.queued', { count: n }) : '');
},

// Send now, or queue until the connection is back. Returns true when queued.
_sendOrQueue(event, payload, shownText) {
  if (!this._isOffline()) { this.socket.emit(event, payload); return false; }
  if (!this._outbox) this._outbox = [];
  if (this._outbox.length >= MAX_OUTBOX) {
    this._showToast?.(t('app.offline.outbox_full'), 'error');
    return true;
  }
  const id = `ob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  this._outbox.push({ id, event, payload });
  this._renderPendingMessage(id, payload, shownText);
  this._renderOfflineBanner();
  return true;
},

_renderPendingMessage(id, payload, shownText) {
  if (!payload || payload.code !== this.currentChannel) return;
  const list = document.getElementById('messages');
  if (!list) return;
  const el = document.createElement('div');
  el.className = 'message message-pending';
  el.dataset.outboxId = id;
  el.style.opacity = '0.6';
  const body = document.createElement('div');
  body.className = 'message-content';
  // Encrypted DMs are already ciphertext here; show the typed text instead.
  body.textContent = shownText || (payload.encrypted ? '' : payload.content) || '';
  const tag = document.createElement('div');
  tag.className = 'muted-text message-pending-label';
  tag.style.fontSize = '11px';
  tag.textContent = t('app.offline.pending');
  el.append(body, tag);
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
},

// The last few channels' messages, kept as the nodes that were on screen
// (moved, not copied), so switching between loaded channels while offline
// shows what was there instead of an empty list. Memory only; online, the
// history the server sends replaces it as usual.
_offlineStash(code, el) {
  if (!code || !el || !el.firstChild) return;
  if (!this._offlineSnapshots) this._offlineSnapshots = new Map();
  const frag = document.createDocumentFragment();
  while (el.firstChild) frag.appendChild(el.firstChild);
  this._offlineSnapshots.delete(code);
  this._offlineSnapshots.set(code, frag);
  while (this._offlineSnapshots.size > 6) this._offlineSnapshots.delete(this._offlineSnapshots.keys().next().value);
},

_offlineRestore(code, el) {
  const frag = this._offlineSnapshots?.get(code);
  if (!frag) return false;
  this._offlineSnapshots.delete(code);
  if (!this._isOffline()) return false;
  el.appendChild(frag);
  el.scrollTop = el.scrollHeight;
  return true;
},

// Everything queued goes out in the order it was written. Each entry leaves
// the outbox as it is handed to a connected socket, so a later reconnect can
// never send it a second time.
_flushOutbox() {
  if (!this._outbox || !this._outbox.length) return;
  while (this._outbox.length && this.socket && this.socket.connected) {
    const item = this._outbox.shift();
    this.socket.emit(item.event, item.payload);
    document.querySelectorAll(`[data-outbox-id="${item.id}"]`).forEach(el => el.remove());
  }
  // Snapshots may hold pending rows; the server's history is current again.
  this._offlineSnapshots?.clear();
  this._renderOfflineBanner();
},

};

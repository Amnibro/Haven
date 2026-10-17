// Marking one message NSFW from its menu (right-click, or the toolbar's ⋯).
//
// A marked message keeps its text, pictures, videos and link cards blurred
// until it is clicked, in the channel, a thread and the DM pop-out. The blur
// follows the "Blur NSFW" setting that forum topics use, and a click only
// shows the message: it does not also open the picture viewer, a link or a
// video. The server decides who may set the mark (src/messageNsfw.js).
//
// The state lives in data attributes rather than classes, so a compact row
// promoted to a full one (which rewrites its classes) stays covered.

export default {

_setupMessageNsfw() {
  this.socket.on('message-nsfw', (data) => {
    if (!data || !Number.isInteger(data.messageId)) return;
    const id = data.messageId;
    document.querySelectorAll(`#messages [data-msg-id="${id}"], #thread-messages .thread-message[data-msg-id="${id}"], #dm-pip-messages [data-msg-id="${id}"]`)
      .forEach(el => {
        this._applyMessageNsfw(el, !!data.nsfw);
        // The toolbar button offers the other way round now.
        el.querySelectorAll('[data-action="nsfw"], [data-action="unnsfw"], [data-thread-action="nsfw"], [data-thread-action="unnsfw"]').forEach(btn => {
          const key = btn.dataset.threadAction ? 'threadAction' : 'action';
          btn.dataset[key] = data.nsfw ? 'unnsfw' : 'nsfw';
          btn.title = t(data.nsfw ? 'msg_toolbar.unmark_nsfw' : 'msg_toolbar.mark_nsfw');
        });
      });
  });
  // Capture phase, so the click reaches nothing inside the covered message.
  document.addEventListener('click', (e) => {
    const box = e.target.closest?.('[data-nsfw="1"]:not([data-nsfw-shown]) :is(.message-content, .thread-msg-content)');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    box.closest('[data-nsfw="1"]').dataset.nsfwShown = '1';
  }, true);
},

_applyMessageNsfw(el, nsfw) {
  if (!el) return;
  if (!nsfw) {
    delete el.dataset.nsfw;
    delete el.dataset.nsfwShown;
    return;
  }
  el.dataset.nsfw = '1';
  // The cover's words, set here rather than at start-up, when the language
  // may not have loaded yet.
  document.documentElement.style.setProperty('--nsfw-message-label', JSON.stringify(t('msg_toolbar.nsfw_hidden')));
  // With the blur switched off in Settings, a marked message shows as is.
  if (this._blurNsfw && !this._blurNsfw()) el.dataset.nsfwShown = '1';
  else delete el.dataset.nsfwShown;
},

// Whether the menu offers the mark on this message. The server checks again.
_canSetMessageNsfw(msgEl, isDm) {
  const own = !!msgEl && String(msgEl.dataset.userId) === String(this.user?.id);
  if (isDm) return own;
  return own || !!this.user?.isAdmin || !!this._canModerate?.() || !!this._hasPerm?.('delete_message');
},

_setMessageNsfw(msgId, nsfw) {
  this.socket.emit('set-message-nsfw', { messageId: msgId, nsfw }, (res) => {
    if (res && res.error) this._showToast?.(res.error, 'error');
  });
},

// The menu item, as a toolbar button or a context menu row.
_messageNsfwToolbarHtml(marked, icon) {
  return marked
    ? `<button data-action="unnsfw" title="${t('msg_toolbar.unmark_nsfw')}">${icon}</button>`
    : `<button data-action="nsfw" title="${t('msg_toolbar.mark_nsfw')}">${icon}</button>`;
},

_messageNsfwMenuHtml(marked) {
  return marked
    ? `<button class="channel-ctx-item" data-action="unnsfw">🔞 <span>${t('msg_toolbar.unmark_nsfw')}</span></button>`
    : `<button class="channel-ctx-item" data-action="nsfw">🔞 <span>${t('msg_toolbar.mark_nsfw')}</span></button>`;
},

};

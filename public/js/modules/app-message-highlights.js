// Official messages (src/messageHighlights.js): a role with Highlight
// Messages can post as that role. The message gets the role's colour down its
// side and a badge with the role's name. The composer button marks the next
// message; the message menu marks or unmarks one already sent.

export default {

_setupMessageHighlights() {
  document.getElementById('highlight-btn')?.addEventListener('click', () => {
    this._setHighlightArmed(!this._highlightArmed);
  });
  this.socket.on('message-highlight', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    document.querySelectorAll(`#messages [data-msg-id="${Number(data.messageId)}"]`)
      .forEach(el => this._applyMessageHighlight(el, data.highlight || null));
  });
},

_canHighlightMessages() {
  return !!(this.user?.isAdmin || this._hasPerm?.('highlight_messages'));
},

// Called on every channel switch: the button is for channels, not DMs, and
// a mark never carries over to another channel.
_updateHighlightButton(isDm) {
  const hidden = isDm || !this._canHighlightMessages();
  const btn = document.getElementById('highlight-btn');
  const div = document.getElementById('highlight-divider');
  if (btn) btn.style.display = hidden ? 'none' : '';
  if (div) div.style.display = hidden ? 'none' : '';
  this._setHighlightArmed(false);
},

_setHighlightArmed(on) {
  this._highlightArmed = !!on;
  const btn = document.getElementById('highlight-btn');
  if (!btn) return;
  btn.classList.toggle('active', this._highlightArmed);
  btn.setAttribute('aria-pressed', String(this._highlightArmed));
  btn.title = t(this._highlightArmed ? 'app.input_bar.highlight_btn_armed' : 'app.input_bar.highlight_btn');
},

_highlightColor(h) {
  return this._safeColor(h && h.color, 'var(--accent)');
},

_highlightBadgeHtml(h) {
  const role = { name: h.role || '', color: h.color, color2: h.color2, color_shimmer: h.shimmer };
  const label = h.role ? this._roleNameHtml(role, h.role) : this._escapeHtml(t('app.messages.official'));
  const title = h.role ? t('app.messages.official_as', { role: h.role }) : t('app.messages.official');
  return `<span class="msg-highlight-badge" title="${this._escapeHtml(title)}">📣 ${label}</span>`;
},

// Adds, updates or removes the mark on a rendered message.
_applyMessageHighlight(el, h) {
  el.querySelectorAll(':scope .msg-highlight-badge').forEach(b => b.remove());
  if (!h) {
    el.classList.remove('message-highlighted');
    el.style.removeProperty('--hl-color');
    delete el.dataset.highlighted;
    return;
  }
  el.classList.add('message-highlighted');
  el.style.setProperty('--hl-color', this._highlightColor(h));
  el.dataset.highlighted = '1';
  const time = el.querySelector('.message-header .message-time');
  if (time) time.insertAdjacentHTML('beforebegin', this._highlightBadgeHtml(h));
  else el.querySelector('.message-content')?.insertAdjacentHTML('afterbegin', this._highlightBadgeHtml(h) + ' ');
},

};

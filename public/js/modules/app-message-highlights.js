// Official messages (src/messageHighlights.js): a role with Highlight
// Messages can post as that role. The message gets the role's colour down its
// side and a badge with the role's name. The composer button marks the next
// message; the message menu marks or unmarks one already sent.
//
// Two settings change how that works, both off unless someone picks them:
// - Keep official mode on (saved on the account): the button stays armed, so
//   every message goes out official until it is turned off. Pressing the
//   button then sends just the next message plain.
// - How official messages look to the reader (this device): the badge (the
//   default), Coloured text (the text and a light wash in the role's colour,
//   no badge, and a run of official messages from one person reads as one
//   block), or Off (they look like any other message).

const OFFICIAL_STYLES = ['badge', 'text', 'off'];

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

  // Keep official mode on: the account's setting, from session-info, and
  // from any of this person's devices when it changes.
  const modeToggle = document.getElementById('official-mode-toggle');
  modeToggle?.addEventListener('change', () => this._setOfficialMode(modeToggle.checked));
  this.socket.on('session-info', () => this._syncOfficialMode());
  this.socket.on('roles-updated', (data) => {
    if (!data || !this.currentChannel) return;
    const ch = this.channels?.find(c => c.code === this.currentChannel);
    // A button pressed for the next message stays pressed while it is still
    // allowed; only losing the permission turns it off.
    const armed = this._highlightArmed;
    this._updateHighlightButton(!!ch?.is_dm);
    this._syncOfficialMode();
    if (armed && this._highlightAvailable) this._setHighlightArmed(true);
  });
  this.socket.on('official-mode-changed', (data) => {
    if (!data || typeof data.officialMode !== 'boolean') return;
    this.user.officialMode = data.officialMode;
    this._syncOfficialMode();
  });

  // How official messages look on this device.
  this._applyOfficialStyle(this._officialStyle());
  const styleSelect = document.getElementById('official-style-select');
  if (styleSelect) {
    styleSelect.value = this._officialStyle();
    styleSelect.addEventListener('change', () => {
      try { localStorage.setItem('haven_official_style', styleSelect.value); } catch { /* storage blocked: the choice lasts until reload */ }
      this._applyOfficialStyle(styleSelect.value);
      // Grouping depends on the look, so the open channel is drawn again.
      if (this.currentChannel && this.socket?.connected) {
        this.socket.emit('get-messages', this._getMessagesParams ? this._getMessagesParams(this.currentChannel) : { code: this.currentChannel });
      }
    });
  }
},

_canHighlightMessages() {
  return !!(this.user?.isAdmin || this._hasPerm?.('highlight_messages'));
},

// Called on every channel switch: the button is for channels, not DMs, and
// a mark never carries over to another channel. With official mode kept on,
// the button starts armed instead.
_updateHighlightButton(isDm) {
  const hidden = isDm || !this._canHighlightMessages();
  const btn = document.getElementById('highlight-btn');
  const div = document.getElementById('highlight-divider');
  if (btn) btn.style.display = hidden ? 'none' : '';
  if (div) div.style.display = hidden ? 'none' : '';
  this._highlightAvailable = !hidden;
  this._setHighlightArmed(this._highlightDefault());
},

// Where the button rests: armed while official mode is kept on, otherwise
// off. After a message goes out the button comes back here.
_highlightDefault() {
  return !!(this._highlightAvailable && this.user?.officialMode);
},

_setHighlightArmed(on) {
  this._highlightArmed = !!on;
  const btn = document.getElementById('highlight-btn');
  if (!btn) return;
  btn.classList.toggle('active', this._highlightArmed);
  btn.setAttribute('aria-pressed', String(this._highlightArmed));
  const key = this.user?.officialMode
    ? (this._highlightArmed ? 'app.input_bar.highlight_btn_mode_on' : 'app.input_bar.highlight_btn_mode_skip')
    : (this._highlightArmed ? 'app.input_bar.highlight_btn_armed' : 'app.input_bar.highlight_btn');
  btn.title = t(key);
},

_setOfficialMode(on) {
  const before = !!this.user.officialMode;
  this.user.officialMode = !!on;
  this._syncOfficialMode();
  this.socket.emit('set-official-mode', { enabled: !!on }, (res) => {
    if (res && res.ok) return;
    this.user.officialMode = before;
    this._syncOfficialMode();
    if (res && res.error) this._showToast?.(res.error, 'error');
  });
},

// Brings the Settings switch and the composer button in line with the
// account's official mode. The switch only shows to people who can post
// official messages somewhere.
_syncOfficialMode() {
  const row = document.getElementById('official-mode-setting');
  if (row) {
    const perms = [...(this.user?.permissions || []), ...(this.user?.globalPermissions || [])];
    const can = !!(this.user?.isAdmin || perms.includes('*') || perms.includes('highlight_messages'));
    row.style.display = can ? '' : 'none';
  }
  const box = document.getElementById('official-mode-toggle');
  if (box) box.checked = !!this.user?.officialMode;
  this._setHighlightArmed(this._highlightDefault());
},

_officialStyle() {
  let style = null;
  try { style = localStorage.getItem('haven_official_style'); } catch { /* storage blocked: the default look */ }
  return OFFICIAL_STYLES.includes(style) ? style : 'badge';
},

_applyOfficialStyle(style) {
  const root = document.documentElement;
  if (!OFFICIAL_STYLES.includes(style) || style === 'badge') delete root.dataset.officialStyle;
  else root.dataset.officialStyle = style;
  if (style === 'text') this._watchOfficialTextMix();
},

// Whether the official mark lets two messages from the same person share a
// group. With the badge, an official message always shows who said it and
// does not swallow the next one either. With Coloured text, official
// messages group with each other (one block per run) and plain ones with
// plain ones. With the look turned off, the mark makes no difference.
_highlightGroups(msg, prevMsg) {
  const style = this._officialStyle();
  if (style === 'off') return true;
  if (style === 'text') return !!msg.highlight === !!prevMsg.highlight;
  return !msg.highlight && !prevMsg.highlight;
},

// Coloured text mixes the role colour with the theme's text colour. A pale
// role colour washes out on a light background, so light themes get more
// of the text colour. Follows theme switches, theme files included.
_watchOfficialTextMix() {
  if (this._officialMixWatched) return;
  this._officialMixWatched = true;
  const probe = document.createElement('span');
  probe.style.cssText = 'display:none;color:var(--bg-primary)';
  document.body.appendChild(probe);
  let queued = false;
  const update = () => {
    queued = false;
    const rgb = (getComputedStyle(probe).color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const light = rgb.length === 3 && (0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])) > 0.4;
    document.documentElement.style.setProperty('--hl-text-mix', light ? '38%' : '60%');
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  update();
  new MutationObserver(queue).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  new MutationObserver(queue).observe(document.head, { childList: true });
  document.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'LINK') queue(); }, true);
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

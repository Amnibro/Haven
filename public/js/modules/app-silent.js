// Silent messages: sent without a sound, a pop-up or a push for anyone.
// Mentions in one still highlight and still mark the channel; they just do
// not ping. Start a message with "@silent" (as on Discord) or press the muted
// bell in the message box for the next message. The server takes the prefix
// off and stores the mark (src/silentMessages.js); an encrypted DM sends the
// mark alone, since the server cannot read its text. A muted bell next to
// the message says why it made no noise.

export default {

// { silent, content } for what was typed: "@silent" up front is taken off
// here too, so an encrypted DM never carries it. Left alone when nothing
// follows it, unless attachments go with it.
_silentSplit(content, hasAttachments = false) {
  const text = typeof content === 'string' ? content : '';
  const m = /^\s*@silent(?:[ \t]+|\r?\n|$)/i.exec(text);
  if (m) {
    const rest = text.slice(m[0].length);
    if (rest.trim() || hasAttachments) return { silent: true, content: rest.trim() };
  }
  return { silent: false, content: text };
},

_setupSilentToggle() {
  document.getElementById('silent-btn')?.addEventListener('click', () => {
    this._setSilentArmed(!this._silentArmed);
  });
},

// The toggle covers the next message only, like the self-destruct one.
_setSilentArmed(on) {
  this._silentArmed = !!on;
  const btn = document.getElementById('silent-btn');
  if (!btn) return;
  btn.classList.toggle('active', this._silentArmed);
  btn.setAttribute('aria-pressed', String(this._silentArmed));
  const label = t(this._silentArmed ? 'app.input_bar.silent_btn_armed' : 'app.input_bar.silent_btn');
  btn.title = label;
  btn.setAttribute('aria-label', label);
},

// The muted bell after a silent message's text.
_silentTagHtml(msg) {
  if (!msg || !msg.silent) return '';
  const hint = this._escapeHtml(t('app.messages.silent_hint'));
  return `<span class="silent-tag" title="${hint}" aria-label="${hint}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg></span>`;
},

// An edit redraws the text; the bell goes back after it.
_restoreSilentTag(msgEl, contentEl) {
  if (!msgEl || !contentEl || msgEl.dataset.silent !== '1' || contentEl.querySelector('.silent-tag')) return;
  contentEl.insertAdjacentHTML('beforeend', this._silentTagHtml({ silent: true }));
},

};

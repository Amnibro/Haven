export default {
_setupLayoutVotes() {
  if (this._layoutVotesReady) return;
  this._layoutVotesReady = true;
  this.socket.on('layout-votes', (d) => { if (d?.tally && this._layoutVotes) { this._layoutVotes.tally = d.tally; this._renderLayoutVotes(); } });
  const load = () => this.socket.emit('get-layout-votes', {}, (res) => { if (res && !res.error) { this._layoutVotes = res; this._renderLayoutVotes(); } });
  document.getElementById('settings-nav')?.addEventListener('click', (e) => { if (e.target.closest('.settings-nav-item')?.dataset.target === 'section-layout') load(); });
  document.getElementById('open-settings-btn')?.addEventListener('click', load);
  this.socket.on('connect', () => this._layoutVotes && load());
},
_renderLayoutVotes() {
  const v = this._layoutVotes, anchor = document.getElementById('layout-style-subsection');
  if (!v || !anchor) return;
  const tr = (k, f) => { const s = typeof t === 'function' ? t(k) : ''; return s && s !== k ? s : f; };
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
  let box = document.getElementById('layout-votes-subsection');
  if (!box) {
    box = Object.assign(el('div', 'settings-subsection'), { id: 'layout-votes-subsection' });
    box.append(el('small', 'settings-group-label', `🗳️ ${tr('settings.layout.votes.title', 'Focus concepts: vote for your favorites')}`), el('small', 'settings-hint', tr('settings.layout.votes.hint', 'Vote for every layout you like. The ones with Try it are ready in the picker above; the rest are designs that could be built next. Everyone on this server sees the totals.')), el('div', 'lv-grid'));
    anchor.after(box);
  }
  const mine = new Set(v.mine || []), top = Math.max(0, ...Object.values(v.tally || {})), loaded = window.HavenPluginLoader?.loadedPlugins;
  box.querySelector('.lv-grid').replaceChildren(...(v.catalog || []).map(c => {
    const n = v.tally?.[c.id] || 0, on = mine.has(c.id), card = el('div', 'lv-card' + (on ? ' voted' : '')), body = el('div', 'lv-body'), row = el('div', 'lv-row');
    const img = Object.assign(el('img', 'lv-img'), { src: c.image, alt: `${c.name} ${tr('settings.layout.votes.preview', 'preview')}`, loading: 'lazy', decoding: 'async', tabIndex: 0, onclick: () => card.classList.toggle('big'), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), card.classList.toggle('big')) });
    const vote = Object.assign(el('button', 'lv-vote', `▲ ${n}`), { type: 'button', title: on ? tr('settings.layout.votes.unvote', 'Take your vote back') : tr('settings.layout.votes.vote', 'Vote for this layout') });
    vote.setAttribute('aria-pressed', String(on));
    vote.setAttribute('aria-label', `${c.name}: ${n} ${tr('settings.layout.votes.votes', 'votes')}`);
    vote.addEventListener('click', () => { vote.disabled = true; this.socket.emit('vote-layout', { id: c.id, on: !on }, (res) => { vote.disabled = false; if (res && !res.error) { this._layoutVotes.tally = res.tally; this._layoutVotes.mine = res.mine; this._renderLayoutVotes(); } else if (res?.error) this._showToast?.(res.error, 'error'); }); });
    const title = el('div', 'lv-name', c.name);
    n && n === top && title.append(el('span', 'lv-top', tr('settings.layout.votes.leading', 'Leading')));
    row.append(vote);
    c.layout && loaded?.has(`${c.layout}.plugin.js`) && row.append(Object.assign(el('button', 'lv-try', tr('settings.layout.votes.try', 'Try it')), { type: 'button', onclick: () => typeof _setLayout === 'function' && _setLayout(c.layout) }));
    body.append(title, el('div', 'lv-desc', c.description), row);
    card.append(img, body);
    return card;
  }));
},
};

/**
 * @name Focus Layout
 * @description Carousel Focus view, picked in Settings, Layout. The conversation that needs you sits in the middle, the one you just cleared fades on the left and the next one waits on the right. Menus live in a dock along the bottom. Replies aim at a person's message, and sending moves you to the next thing to answer. Press the ? button for shortcuts.
 * @author Amni-Scient
 * @version 2.0.0
 */
class FocusLayout {
  start() {
    if (this._started) return;
    Object.assign(this, { _started: true, _engaged: false, _placed: [], _built: [], _off: [], _media: window.matchMedia('(min-width: 901px)'), _chip: 'all', _seq: 0, _skip: [], _aim: null, _pop: null, _entered: false });
    HavenApi.DOM.addStyle('FocusLayout', FocusLayout.CSS);
    this._on(this._media, 'change', () => this._sync());
    this._on(document, 'haven:layout-editing', () => this._sync());
    this._on(document, 'haven:layout-owner-change', (e) => e.detail?.owner !== 'FocusLayout' && this._sync());
    this._on(document, 'keydown', (e) => this._key(e), true);
    this._on(window, 'resize', () => this._railSoon());
    this._wire = setInterval(() => this._attach(), 1000);
    this._attach();
    HavenApi.Data.load('FocusLayout', 'layoutOn', '1') !== '0' && this._engage(false);
  }
  stop() {
    if (!this._started) return;
    this._disengage(false);
    clearInterval(this._wire);
    clearTimeout(this._pending);
    this._sock && ['new-message', 'search-results', 'connect'].forEach(ev => this._sock.off(ev, this._handlers[ev]));
    HavenApi.Patcher.unpatchAll('FocusLayout');
    this._off.forEach(([t, ty, fn, o]) => t.removeEventListener(ty, fn, o));
    Object.assign(this, { _off: [], _sock: null, _patched: false, _started: false });
    HavenApi.DOM.removeStyle('FocusLayout');
  }
  _on(t, ty, fn, o) { t.addEventListener(ty, fn, o); this._off.push([t, ty, fn, o]); }
  _t(key, fallback) { const s = typeof window.t === 'function' ? window.t(key) : null; return typeof s === 'string' && s && s !== key ? s : fallback; }
  _engage(persist = true) {
    if (this._engaged) return;
    this._engaged = true;
    document.documentElement.setAttribute('data-focus-layout', '1');
    persist && HavenApi.Data.save('FocusLayout', 'layoutOn', '1');
    this._sync();
  }
  _disengage(persist = true) {
    if (!this._engaged) return;
    this._engaged = false;
    this._restore();
    document.documentElement.removeAttribute('data-focus-layout');
    persist && HavenApi.Data.save('FocusLayout', 'layoutOn', '0');
  }
  _sync() { this._engaged && this._media?.matches && !document.documentElement.hasAttribute('data-haven-layout-editing') ? this._apply() : this._restore(); }
  _attach() {
    const app = window.app, s = HavenApi.socket;
    if (app && !this._patched && typeof app._renderChannels === 'function') {
      this._patched = true;
      ['_renderChannels', '_updateBadge', '_updateTabTitle', '_appendMessage', '_renderMessages'].forEach(m => HavenApi.Patcher.after('FocusLayout', app, m, () => { this._soon(); }));
      HavenApi.Patcher.before('FocusLayout', app, 'switchChannel', (args) => this._promote(args[0]));
      HavenApi.Patcher.after('FocusLayout', app, 'switchChannel', (args) => { this._seen(args[0]); this._arrived(args[0]); });
      HavenApi.Patcher.before('FocusLayout', app, '_sendMessage', () => { this._pre = { code: app.currentChannel, id: app.replyingTo?.id, who: app.replyingTo?.username }; });
      HavenApi.Patcher.after('FocusLayout', app, '_sendMessage', (args, r) => { const pre = this._pre; Promise.resolve(r).then(ok => ok !== false && pre && this._done(pre, 'replied')); });
      HavenApi.Patcher.after('FocusLayout', app, '_clearReply', () => { this._aim && !app.replyingTo && this._unaim(); });
    }
    if (!s || s === this._sock) return;
    this._sock && ['new-message', 'search-results', 'connect'].forEach(ev => this._sock.off(ev, this._handlers[ev]));
    this._sock = s;
    this._handlers = { 'new-message': (d) => setTimeout(() => this._incoming(d), 400), 'search-results': (d) => this._backfilled(d), connect: () => this._backfill() };
    Object.entries(this._handlers).forEach(([ev, fn]) => s.on(ev, fn));
    s.connected && this._backfill();
  }
  _apply() {
    if (this._dock) return this._render();
    const q = (sel) => document.querySelector(sel), R = (n) => q(`[data-haven-region="${n}"]`);
    const side = R('navigation-sidebar'), bar = R('server-rail'), main = R('main'), chans = R('channels'), dms = R('direct-messages'), account = R('account'), ctx = R('context-sidebar');
    if (!side || !bar || !main || !chans || !dms || !account) return console.warn('[FocusLayout] Required layout regions are unavailable');
    if (HavenApi.Layout && !HavenApi.Layout.acquire('FocusLayout')) return;
    const el = this._el, svg = (p, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
    const dock = this._dock = el('nav', 'fc-dock'), row = el('div', 'fc-row'), servers = el('div', 'fc-servers'), pop = this._popEl = el('div', 'fc-pop');
    dock.setAttribute('aria-label', this._t('focus.menu', 'Menu'));
    pop.setAttribute('role', 'dialog');
    row.append(servers, el('span', 'fc-di fc-sep'));
    FocusLayout.DOCK.forEach(([id, key, label, path, act]) => {
      if (id === '|') return row.append(el('span', 'fc-di fc-sep'));
      const b = Object.assign(el('button', 'fc-di fc-tip'), { type: 'button', innerHTML: id === 'you' ? '<span class="fc-me"></span>' : svg(path), onclick: () => this._dockAct(id, act) });
      Object.assign(b.dataset, { id, tip: this._t(key, label) });
      b.setAttribute('aria-label', b.dataset.tip);
      b.append(el('b', 'fc-badge'));
      row.append(b);
    });
    dock.append(row);
    const panes = { activity: el('div', 'fc-pane fc-activity'), dms: el('div', 'fc-pane'), channels: el('div', 'fc-pane'), people: el('div', 'fc-pane'), you: el('div', 'fc-pane fc-you'), help: el('div', 'fc-pane fc-help') };
    panes.activity.append(el('div', 'fa-head', this._t('users.activity', 'Activity')), el('div', 'fa-chips'), el('div', 'fa-list'));
    Object.entries(panes).forEach(([k, p]) => { p.dataset.pane = k; pop.append(p); });
    this._panes = panes;
    const help = el('button', 'fc-help-btn fc-tip', '?');
    Object.assign(help, { type: 'button', onclick: () => this._toggle('help') });
    help.dataset.tip = this._t('focus.controls', 'Controls');
    help.setAttribute('aria-label', help.dataset.tip);
    panes.help.append(el('div', 'fa-head', help.dataset.tip), ...FocusLayout.KEYS.map(([k, key, label]) => { const r = el('div', 'fc-key'); r.append(el('span', '', this._t(key, label)), el('kbd', '', k)); return r; }));
    const left = this._left = el('button', 'fc-side fc-left'), right = this._right = el('button', 'fc-side fc-right');
    left.type = right.type = 'button';
    left.onclick = () => this._back();
    right.onclick = () => this._next();
    const flash = this._flashEl = el('div', 'fc-flash'), rail = this._railEl = el('div', 'fc-rail'), prog = this._prog = el('div', 'fc-progress'), banner = this._banner = el('div', 'fc-banner');
    flash.setAttribute('aria-live', 'polite');
    document.body.append(dock, pop, help, left, right, banner);
    main.append(flash, rail);
    R('composer')?.after(prog);
    this._built = [dock, pop, help, left, right, banner, flash, rail, prog];
    this._move(bar, servers, null);
    this._move(dms, panes.dms, null);
    [R('join-channel'), R('create-channel'), chans].filter(Boolean).forEach(n => this._move(n, panes.channels, null));
    ctx && this._move(ctx, panes.people, null);
    this._move(account, panes.you, null);
    FocusLayout.YOU.forEach(([sel, key, label]) => q(sel) && panes.you.append(Object.assign(el('button', 'fy-row', this._t(key, label)), { type: 'button', onclick: () => { this._toggle(null); q(sel)?.click(); } })));
    this._on(document, 'click', (e) => this._outside(e), true);
    this._on(R('message-list') || document, 'click', (e) => this._clickAim(e));
    this._on(R('message-list') || document, 'scroll', () => this._railSoon(), true);
    this._on(bar, 'click', (e) => this._leave(e), true);
    document.documentElement.setAttribute('data-focus-desktop', '1');
    this._enter();
    this._render();
    setTimeout(() => { const app = window.app, first = this._queue()[0]?.code || (app?.channels || []).find(c => !c.is_dm && !c.is_forum)?.code; app && !app.currentChannel && first && this._go(first); }, 900);
  }
  _el(tag, cls, text) { return Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {}); }
  _move(node, parent, before) { this._placed.push([node, node.parentNode, node.nextSibling]); parent.insertBefore(node, before); }
  _restore() {
    const root = document.documentElement;
    ['data-focus-desktop', 'data-fc-flash', 'data-fc-enter', 'data-fc-leave', 'data-fc-pop'].forEach(a => root.removeAttribute(a));
    this._placed.reverse().forEach(([node, parent, next]) => parent.insertBefore(node, next?.parentNode === parent ? next : null));
    this._built.forEach(n => n.remove());
    document.querySelectorAll('.fc-aimed').forEach(n => n.classList.remove('fc-aimed'));
    Object.assign(this, { _placed: [], _built: [], _dock: null, _popEl: null, _panes: null, _left: null, _right: null, _flashEl: null, _railEl: null, _prog: null, _banner: null, _pop: null, _aim: null });
    HavenApi.Layout?.release('FocusLayout');
  }
  _dockAct(id, act) { act ? document.querySelector(act)?.click() : this._toggle(id); }
  _toggle(id) {
    this._pop = id && id !== this._pop ? id : null;
    const root = document.documentElement;
    this._pop ? root.setAttribute('data-fc-pop', this._pop) : root.removeAttribute('data-fc-pop');
    this._pop === 'activity' && this._renderActivity();
    this._render();
  }
  _outside(e) { this._pop && !e.target.closest?.('.fc-pop, .fc-dock, .fc-help-btn, .modal, .modal-overlay, [role="menu"], .context-menu') && this._toggle(null); }
  _key(e) {
    if (!this._dock) return;
    const k = e.code || '', bare = !e.ctrlKey && !e.metaKey, input = e.target?.id === 'message-input', empty = input && !e.target.value, dd = ['mention-dropdown', 'slash-dropdown', 'emoji-dropdown', 'channel-dropdown'].some(id => { const d = document.getElementById(id); return d && d.offsetParent; });
    const go = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (e.key === 'Escape' && this._pop) return this._toggle(null);
    if (k === 'Tab' && empty && !dd && bare && !e.altKey) return go(() => e.shiftKey ? this._back() : this._next());
    if (!e.altKey || !bare || e.shiftKey) return;
    const n = /^Digit([1-9])$/.exec(k);
    n ? go(() => this._dock.querySelectorAll('.server-icon')[n[1] - 1]?.click())
      : k === 'ArrowRight' ? go(() => this._next()) : k === 'ArrowLeft' ? go(() => this._back())
      : k === 'BracketLeft' || k === 'BracketRight' ? go(() => this._step(k === 'BracketLeft' ? -1 : 1))
      : k === 'KeyL' ? go(() => this._like()) : k === 'KeyJ' ? go(() => document.getElementById('voice-btn')?.click())
      : k === 'KeyK' ? go(() => this._toggle('channels')) : k === 'KeyD' ? go(() => this._toggle('dms')) : k === 'KeyA' ? go(() => this._toggle('activity')) : k === 'Slash' ? go(() => this._toggle('help')) : null;
  }
  _soon() { clearTimeout(this._pending); this._pending = setTimeout(() => this._dock && (this._render(), this._rail()), 120); }
  _railSoon() { cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame(() => this._rail()); }
  _chan(code) { return (window.app?.channels || []).find(c => c.code === code); }
  _name(code) { const c = this._chan(code); return !c ? '' : c.is_dm ? (c.dm_target?.displayName || c.dm_target?.username || c.name) : '#' + c.name; }
  _serverName() { return (document.querySelector('.sidebar-header .brand-text')?.textContent || '').trim().replace(/^HAVEN$/, 'Haven') || document.title || 'Haven'; }
  _store() { try { return JSON.parse(HavenApi.Data.load('FocusLayout', 'inbox:' + location.host, '[]')) || []; } catch { return []; } }
  _keep(items) { HavenApi.Data.save('FocusLayout', 'inbox:' + location.host, JSON.stringify(items.sort((a, b) => b.at - a.at).slice(0, 150))); this._soon(); }
  _cleared() { try { return JSON.parse(HavenApi.Data.load('FocusLayout', 'cleared:' + location.host, '[]')) || []; } catch { return []; } }
  _clear(list) { HavenApi.Data.save('FocusLayout', 'cleared:' + location.host, JSON.stringify(list.slice(-30))); }
  _muted(code) { try { return JSON.parse(localStorage.getItem('haven_muted_channels') || '[]').includes(code); } catch { return false; } }
  _classify(code, m) {
    const app = window.app, me = app?.user, ch = (app?.channels || []).find(c => c.code === code), txt = String(m?.content || '');
    if (!me || !m || !ch || ch.is_dm || m.user_id === me.id || this._muted(code)) return null;
    const esc = String(me.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (esc && new RegExp(`@${esc}(?!\\w)`, 'i').test(txt)) || /(?<![\w@])@(everyone|here)\b/i.test(txt) || app._mentionsMyRole?.(txt) ? 'mention' : m.replyContext?.user_id === me.id ? 'reply' : null;
  }
  _item(code, m, kind, read) { return { k: `${kind}:${code}:${m.id}`, kind, code, id: m.id, who: m.display_name || m.username || '', text: String(m.content || '').replace(/[*_~`>#|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160), at: Date.parse(m.created_at || '') || Date.now(), read, done: read }; }
  _incoming(d) {
    const app = window.app, kind = this._classify(d?.channelCode, d?.message);
    if (!kind) return;
    const read = d.channelCode === app?.currentChannel && document.hasFocus() && !document.hidden, items = this._store();
    items.some(x => x.k === `${kind}:${d.channelCode}:${d.message.id}`) || this._keep([{ ...this._item(d.channelCode, d.message, kind, read), done: false }, ...items]);
  }
  _backfill() {
    const me = window.app?.user?.username;
    if (!me || !this._sock || me.length < 3) return;
    this._token = `focus-${++this._seq}`;
    this._sock.emit('search-messages', { query: me, page: 1, sort: 'newest', token: this._token });
  }
  _backfilled(d) {
    if (!d || d.token !== this._token) return;
    const items = this._store(), have = new Set(items.map(x => x.k));
    const got = (d.results || []).map(r => { const m = { id: r.id, content: r.content, user_id: r.user_id, username: r.username, created_at: r.created_at }, kind = this._classify(r.channel_code, m); return kind === 'mention' ? { ...this._item(r.channel_code, m, kind, true), done: null } : null; }).filter(x => x && !have.has(x.k));
    got.length && this._keep([...items, ...got]);
  }
  _seen(code) {
    const items = this._store();
    items.some(x => x.code === code && !x.read) && this._keep(items.map(x => x.code === code ? { ...x, read: true } : x));
  }
  _markAll() {
    this._keep(this._store().map(x => ({ ...x, read: true, done: true })));
    document.querySelector('[data-action="mark-all-read"]')?.click();
  }
  _live(x, counts, now) { return now - x.at < 2592e5 && (x.done === false || (x.done == null && counts[x.code] > 0)); }
  _open(code) { const counts = window.app?.unreadCounts || {}, now = Date.now(); return this._store().filter(x => this._live(x, counts, now) && (code == null || x.code === code)).sort((a, b) => a.id - b.id); }
  _promote(code) { const items = this._store(), counts = window.app?.unreadCounts || {}, now = Date.now(); items.some(x => x.code === code && x.done == null && this._live(x, counts, now)) && this._keep(items.map(x => x.code === code && x.done == null && this._live(x, counts, now) ? { ...x, done: false } : x)); }
  _unreadRows() {
    const app = window.app, counts = app?.unreadCounts || {};
    return (app?.channels || []).filter(c => counts[c.code] > 0 && (c.is_dm || !this._muted(c.code))).map(c => ({ k: 'u:' + c.code, kind: c.is_dm ? 'dm' : 'unread', code: c.code, count: counts[c.code], who: c.is_dm ? (c.dm_target?.displayName || c.dm_target?.username || c.name) : '#' + c.name, at: 0, read: false }));
  }
  _counts() {
    const app = window.app, counts = app?.unreadCounts || {}, chans = app?.channels || [];
    const dms = chans.filter(c => c.is_dm).reduce((n, c) => n + (counts[c.code] || 0), 0), server = chans.some(c => !c.is_dm && counts[c.code] > 0 && !this._muted(c.code));
    return { channels: server ? -1 : 0, dms, activity: this._store().filter(x => !x.read).length };
  }
  _queue() {
    const cur = window.app?.currentChannel, by = new Map();
    this._open().forEach(x => { const e = by.get(x.code); e ? (e.n++, e.at = Math.max(e.at, x.at)) : by.set(x.code, { code: x.code, kind: x.kind, n: 1, at: x.at, who: x.who, text: x.text }); });
    this._unreadRows().forEach(r => by.has(r.code) || by.set(r.code, { code: r.code, kind: r.kind, n: 0, count: r.count, at: 0, who: r.kind === 'dm' ? r.who : '' }));
    const rank = (e) => (this._skip.includes(e.code) ? 1e3 + this._skip.indexOf(e.code) : 0) + (e.kind === 'unread' ? 100 : 0);
    return [...by.values()].filter(e => e.code !== cur).sort((a, b) => rank(a) - rank(b) || b.at - a.at);
  }
  _label(e) { return e.kind === 'mention' ? (e.n > 1 ? `${e.n} ${this._t('focus.to_answer', 'to answer')}` : this._t('focus.mentioned', 'Mentioned you')) : e.kind === 'reply' ? this._t('focus.replied', 'Replied to you') : e.kind === 'dm' ? this._t('focus.messaged', 'Messaged you') : `${e.count} ${this._t('focus.new_messages', 'new messages')}`; }
  _lines() { return [...document.querySelectorAll('#messages .message, #messages .message-compact')].slice(-3).map(m => { let a = m.querySelector('.message-author')?.textContent, p = m; while (!a && (p = p.previousElementSibling)) a = p.querySelector?.('.message-author')?.textContent; return [a || '', (m.querySelector('.message-content')?.textContent || '').trim().slice(0, 120)]; }).filter(l => l[1]); }
  _done(pre, how) {
    const items = this._store(), hit = items.find(x => x.code === pre.code && x.id === pre.id && !x.done);
    if (!hit && !this._via) return;
    hit && this._keep(items.map(x => x === hit ? { ...x, done: true, read: true } : x));
    const left = this._open(pre.code);
    if (left.length) return setTimeout(() => this._aimAt(left[0].id), 250);
    this._via = null;
    this._unaim();
    setTimeout(() => { this._clear([...this._cleared().filter(c => c.code !== pre.code), { code: pre.code, who: pre.who || '', how, at: Date.now(), lines: this._lines() }]); const next = this._queue()[0]; next ? this._go(next.code) : this._render(); }, 700);
  }
  _like() {
    const a = this._aim, app = window.app;
    if (!a?.id || !app?.socket) return;
    app.socket.emit('add-reaction', { messageId: a.id, emoji: '👍' });
    app._clearReply?.();
    this._done({ code: a.code, id: a.id, who: a.who }, 'liked');
  }
  _next() { const cur = window.app?.currentChannel, q = this._queue(); cur && (this._skip = [...this._skip.filter(c => c !== cur), cur]); q[0] && this._go(q[0].code); }
  _back() {
    const list = this._cleared(), last = list.pop();
    if (!last) return;
    this._clear(list);
    const items = this._store(), lastItem = items.filter(x => x.code === last.code && x.done).sort((a, b) => b.id - a.id)[0];
    lastItem && Date.now() - lastItem.at < 2592e5 && this._keep(items.map(x => x === lastItem ? { ...x, done: false } : x));
    this._go(last.code);
  }
  _go(code) {
    const app = window.app;
    if (!app || !code) return;
    this._via = code;
    this._skip = this._skip.filter(c => c !== code);
    this._flash(code);
    code !== app.currentChannel ? setTimeout(() => app.switchChannel(code), 220) : this._arrived(code);
  }
  _flash(code) {
    const root = document.documentElement, f = this._flashEl, c = this._chan(code), e = this._queue().find(x => x.code === code);
    if (!f) return;
    f.replaceChildren(this._el('b', '', this._name(code)), this._el('span', '', [c?.is_dm ? this._t('focus.dm', 'Direct message') : this._serverName(), e ? this._label(e) : ''].filter(Boolean).join(' · ')));
    root.setAttribute('data-fc-flash', '1');
    clearTimeout(this._ft);
    this._ft = setTimeout(() => root.removeAttribute('data-fc-flash'), 1300);
  }
  _arrived(code) {
    this._unaim();
    this._soon();
    if (!this._dock) return;
    const open = this._open(code), want = open[0]?.id ?? (this._via === code ? 'last' : null);
    want != null && this._waitAim(code, want, 0);
  }
  _waitAim(code, want, n) {
    const app = window.app, msgs = document.querySelectorAll('#messages [data-msg-id]');
    if (app?.currentChannel !== code || n > 30) return;
    if (!msgs.length) return setTimeout(() => this._waitAim(code, want, n + 1), 120);
    const me = app.user?.id, mine = (m) => m.dataset.userId ? +m.dataset.userId === me : (m.querySelector('.message-author')?.textContent || '') === (app.user?.displayName || app.user?.username);
    const id = want === 'last' ? [...msgs].reverse().find(m => !mine(m))?.dataset.msgId : want;
    id && this._aimAt(+id);
  }
  _aimAt(id) {
    const app = window.app, ch = this._chan(app?.currentChannel), el = document.querySelector(`#messages [data-msg-id="${id}"]`);
    if (!app || !id || ch?.is_forum) return;
    if (!el) return app._jumpToMessage?.(id), setTimeout(() => document.querySelector(`#messages [data-msg-id="${id}"]`) && this._aimAt(id), 700);
    document.querySelectorAll('.fc-aimed').forEach(n => n.classList.remove('fc-aimed'));
    el.classList.add('fc-aimed');
    app._setReply?.(el, id);
    this._aim = { code: app.currentChannel, id, who: app.replyingTo?.username || '' };
    const box = document.getElementById('messages'), r = el.getBoundingClientRect(), b = box?.getBoundingClientRect();
    b && (r.top < b.top || r.bottom > b.bottom) && el.scrollIntoView({ block: 'center' });
    this._rail();
    this._render();
  }
  _unaim() { document.querySelectorAll('.fc-aimed').forEach(n => n.classList.remove('fc-aimed')); this._aim = null; this._rail(); }
  _step(d) {
    const all = [...document.querySelectorAll('#messages [data-msg-id]')], i = all.findIndex(m => m.classList.contains('fc-aimed')), next = all[i < 0 ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + d))];
    next && this._aimAt(+next.dataset.msgId);
  }
  _clickAim(e) {
    const m = e.target.closest?.('#messages [data-msg-id]');
    if (!m || e.target.closest('a, button, img, video, audio, input, textarea, .reaction, .message-reactions, .message-avatar, .message-author, .spoiler, code, pre') || String(window.getSelection?.() || '')) return;
    this._aimAt(+m.dataset.msgId);
  }
  _rail() {
    const rail = this._railEl, el = document.querySelector('#messages .fc-aimed'), box = document.getElementById('messages'), bar = document.getElementById('reply-bar'), comp = bar?.offsetParent ? bar : document.querySelector('[data-haven-region="composer"]'), main = document.querySelector('[data-haven-region="main"]');
    if (!rail) return;
    if (!el || !box || !comp || !main || !window.app?.replyingTo) return rail.style.display = 'none';
    const M = main.getBoundingClientRect(), av = (el.querySelector('.message-avatar, .message-avatar-img') || el).getBoundingClientRect(), B = box.getBoundingClientRect(), C = comp.getBoundingClientRect();
    const x = (av === el.getBoundingClientRect() ? av.left + 22 : av.left + av.width / 2) - M.left, top = Math.max(av.bottom - 4, B.top) - M.top, bottom = C.top - M.top + 2;
    Object.assign(rail.style, { display: bottom - top > 8 && av.top < B.bottom ? 'block' : 'none', left: `${x - 2}px`, top: `${top}px`, height: `${bottom - top}px` });
  }
  _enter() {
    if (this._entered) return;
    this._entered = true;
    const root = document.documentElement, b = this._banner;
    b.replaceChildren(this._el('span', 'fc-banner-icon', this._serverName().charAt(0).toUpperCase()), this._el('b', '', this._serverName()));
    root.setAttribute('data-fc-enter', '1');
    setTimeout(() => root.removeAttribute('data-fc-enter'), 1600);
  }
  _leave(e) {
    const icon = e.target.closest?.('.server-icon.remote');
    if (!icon || this._passing) return;
    e.preventDefault();
    e.stopPropagation();
    const root = document.documentElement, b = this._banner;
    b.replaceChildren(this._el('span', 'fc-banner-icon', (icon.title || icon.textContent || '?').trim().charAt(0).toUpperCase()), this._el('b', '', (icon.title || icon.dataset.name || '').trim()));
    root.setAttribute('data-fc-leave', '1');
    setTimeout(() => { this._passing = true; icon.click(); this._passing = false; }, 520);
    setTimeout(() => root.removeAttribute('data-fc-leave'), 2400);
  }
  _render() {
    if (!this._dock) return;
    const counts = this._counts(), root = document.documentElement;
    this._dock.querySelectorAll('.fc-di[data-id]').forEach(b => {
      const n = counts[b.dataset.id], badge = b.querySelector('.fc-badge');
      b.classList.toggle('active', b.dataset.id === this._pop);
      badge.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      badge.classList.toggle('dot', n === -1);
    });
    const me = this._dock.querySelector('.fc-me'), u = window.app?.user;
    me && (me.textContent = (u?.displayName || u?.username || '?').charAt(0).toUpperCase());
    root.toggleAttribute('data-fc-voice', !!document.querySelector('#voice-btn.active, #voice-btn.in-voice, #voice-bar:not([style*="none"])'));
    const q = this._queue(), cl = this._cleared(), last = cl[cl.length - 1], next = q[0], cur = window.app?.currentChannel;
    this._sideCard(this._left, last && last.code !== cur ? { name: this._name(last.code), tag: `✓ ${last.how === 'liked' ? this._t('focus.liked', 'Liked') : this._t('focus.replied_to', 'Replied to') + (last.who ? ' ' + last.who : '')}`, lines: last.lines || [], key: '⇧Tab' } : null);
    this._sideCard(this._right, next ? { name: this._name(next.code), tag: this._t('focus.up_next', 'Up next') + (q.length > 1 ? ` · +${q.length - 1}` : ''), sub: this._label(next), lines: next.text ? [[next.who, next.text]] : [], key: 'Tab' } : null);
    const done = Math.min(cl.length, 12), total = done + (cur ? 1 : 0) + Math.min(q.length, 12);
    this._prog.replaceChildren(Object.assign(this._el('div', 'fc-pips'), {}), this._el('span', 'fc-count', q.length || done ? `${done} ${this._t('focus.cleared_of', 'cleared')} · ${q.length} ${this._t('focus.waiting', 'waiting')}` : this._t('focus.all_clear', 'All clear')));
    this._prog.firstChild.append(...Array.from({ length: total }, (_, i) => this._el('span', i < done ? 'done' : i === done && cur ? 'now' : '')));
    this._pop === 'activity' && this._renderActivity();
  }
  _sideCard(card, d) {
    card.classList.toggle('empty', !d);
    if (!d) return card.replaceChildren();
    const head = this._el('span', 'fs-head'), lines = this._el('span', 'fs-lines');
    head.append(this._el('b', 'fs-name', d.name), this._el('span', 'fs-tag', d.tag));
    d.lines.forEach(([who, text]) => { const l = this._el('span', 'fs-line'); l.append(this._el('b', '', who), this._el('span', '', text)); lines.append(l); });
    card.replaceChildren(head, ...(d.sub ? [this._el('span', 'fs-sub', d.sub)] : []), lines, this._el('kbd', 'fs-key', d.key));
    card.setAttribute('aria-label', `${d.tag}: ${d.name}`);
  }
  _renderActivity() {
    const chips = this._panes.activity.querySelector('.fa-chips'), list = this._panes.activity.querySelector('.fa-list');
    const all = [...this._store(), ...this._unreadRows()], match = (x) => this._chip === 'all' || x.kind === this._chip;
    chips.replaceChildren(...FocusLayout.CHIPS.map(([id, key, label]) => {
      const n = all.filter(x => !x.read && (id === 'all' || x.kind === id)).length, b = Object.assign(this._el('button', 'fa-chip' + (id === this._chip ? ' active' : ''), this._t(key, label) + (n ? ` ${n > 99 ? '99+' : n}` : '')), { type: 'button' });
      b.setAttribute('aria-pressed', String(id === this._chip));
      b.addEventListener('click', () => { this._chip = id; this._renderActivity(); });
      return b;
    }));
    const shown = all.filter(match), fresh = shown.filter(x => !x.read), old = shown.filter(x => x.read).slice(0, 40), section = (label) => this._el('div', 'fa-section', label);
    list.replaceChildren(...(shown.length ? [...(fresh.length ? [section(this._t('focus.new', 'New')), ...fresh.map(x => this._row(x))] : []), ...(old.length ? [section(this._t('focus.earlier', 'Earlier')), ...old.map(x => this._row(x))] : [])] : [this._el('div', 'fa-empty', this._t('media_gallery.empty', 'Nothing here yet'))]));
  }
  _row(x) {
    const el = this._el, ch = this._chan(x.code), place = ch ? (ch.is_dm ? '' : '#' + ch.name) : '', when = x.at ? new Date(x.at) : null;
    const row = Object.assign(el('button', 'fa-row' + (x.read ? '' : ' unread')), { type: 'button' }), av = el('span', 'fa-avatar', x.kind === 'unread' ? '#' : (x.who || '?').replace(/^#/, '').charAt(0).toUpperCase()), main = el('span', 'fa-main'), top = el('span', 'fa-top');
    av.dataset.kind = x.kind;
    top.append(el('span', 'fa-who', x.who), el('span', 'fa-time', when ? (when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : when.toLocaleDateString([], { month: 'short', day: 'numeric' })) : ''));
    const label = { mention: this._t('focus.mentioned', 'Mentioned you'), reply: this._t('focus.replied', 'Replied to you') }[x.kind];
    main.append(top, el('span', 'fa-sub', x.count ? (x.count === 1 ? this._t('focus.new_message', '1 new message') : `${x.count} ${this._t('focus.new_messages', 'new messages')}`) : [label, place].filter(Boolean).join(' · ')), ...(x.text ? [el('span', 'fa-text', x.text)] : []));
    row.append(av, main, ...(x.read ? [] : [el('span', 'fa-dot')]));
    row.addEventListener('click', () => { this._toggle(null); this._keep(this._store().map(y => y.k === x.k ? { ...y, done: false } : y)); this._go(x.code); });
    return row;
  }
}
FocusLayout.DOCK = Object.freeze([
  ['activity', 'users.activity', 'Activity', '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'],
  ['dms', 'app.sidebar.direct_messages', 'Direct Messages', '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'],
  ['channels', 'focus.channels', 'Channels', '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'],
  ['people', 'settings.nav.members', 'Members', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'],
  ['voice', 'focus.voice', 'Voice', '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>', '#voice-btn'],
  ['search', 'ui_search', 'Search', '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>', '#search-toggle-btn'],
  ['|'],
  ['themes', 'settings.plugins_section.themes_label', 'Themes', '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>', '#theme-popup-toggle'],
  ['settings', 'settings.title', 'Settings', '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>', '#open-settings-btn'],
  ['you', 'voice_runtime.you', 'You', '']
]);
FocusLayout.KEYS = Object.freeze([['Enter', 'focus.k_send', 'Send, then the next thing to answer'], ['⇧Enter', 'focus.k_line', 'New line'], ['Tab', 'focus.k_skip', 'Skip (empty message box)'], ['⇧Tab', 'focus.k_back', 'Bring back the last one'], ['Alt →  Alt ←', 'focus.k_arrows', 'Next or back from anywhere'], ['Alt [  Alt ]', 'focus.k_aim', 'Aim at another message'], ['Alt L', 'focus.k_like', 'Like and clear'], ['Alt J', 'focus.k_voice', 'Join or leave voice'], ['Alt K', 'focus.k_channels', 'Channels'], ['Alt D', 'focus.k_dms', 'Direct messages'], ['Alt A', 'focus.k_activity', 'Activity'], ['Alt 1–9', 'focus.k_servers', 'Switch server'], ['Esc', 'focus.k_close', 'Close a menu']]);
FocusLayout.CHIPS = Object.freeze([['all', 'modals.all_members.filter_all', 'All'], ['mention', 'focus.mentions', 'Mentions'], ['reply', 'settings.sounds_section.replies', 'Replies'], ['dm', 'focus.dms', 'DMs'], ['unread', 'focus.unread', 'Unread']]);
FocusLayout.YOU = Object.freeze([['#activities-btn', 'modals.activities.title', 'Activities'], ['#donors-btn', 'focus.support', 'Support Haven']]);
FocusLayout.CSS = `
html[data-focus-desktop="1"] { --fc-w: min(860px, calc(100vw - 96px)); --fc-r: calc(var(--radius, 8px) * 2.25); --fc-ease: cubic-bezier(.2, .8, .2, 1); --fc-shadow: 0 24px 60px color-mix(in srgb, #000 34%, transparent); --fc-side: clamp(0px, calc((100vw - var(--fc-w)) / 2 - 56px), 320px); }
html[data-focus-desktop="1"] [data-haven-region="navigation-sidebar"], html[data-focus-desktop="1"] [data-haven-region="status-bar"], html[data-focus-desktop="1"] #sidebar-split-handle, html[data-focus-desktop="1"] #sidebar-toggle-btn, html[data-focus-desktop="1"] #status-bar-toggle { display: none !important; }
html[data-focus-desktop="1"] [data-haven-region="workspace"] { background: color-mix(in srgb, var(--bg-tertiary) 70%, var(--bg-primary)); justify-content: center; }
html[data-focus-desktop="1"] [data-haven-region="main"] { flex: 0 1 var(--fc-w) !important; width: var(--fc-w) !important; max-width: var(--fc-w) !important; margin: 20px auto 104px !important; height: calc(100vh - 124px) !important; min-height: 0 !important; border-radius: var(--fc-r); overflow: hidden; background: var(--bg-primary); box-shadow: var(--fc-shadow), 0 0 0 1px color-mix(in srgb, var(--border) 70%, transparent); position: relative; transition: transform .75s var(--fc-ease), opacity .55s, filter .55s; }
html[data-focus-desktop="1"] [data-haven-region="channel-header"] { border-bottom-color: color-mix(in srgb, var(--border) 50%, transparent) !important; }
html[data-focus-desktop="1"] [data-haven-region="message-list"] { transition: opacity .45s .15s; }
html[data-focus-desktop="1"][data-fc-flash] [data-haven-region="message-list"], html[data-focus-desktop="1"][data-fc-flash] [data-haven-region="channel-header"] { opacity: 0; transition: opacity .22s; }
html[data-focus-desktop="1"] .fc-flash { position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; pointer-events: none; opacity: 0; transform: translateY(-12px) scale(.98); transition: opacity .5s, transform .7s var(--fc-ease); color: var(--text-primary); text-align: center; padding: 0 24px; }
html[data-focus-desktop="1"] .fc-flash b { font-family: var(--font-heading, var(--font-main)); font-size: clamp(34px, 5vw, 58px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.05; overflow-wrap: anywhere; }
html[data-focus-desktop="1"] .fc-flash span { font-size: 18px; font-weight: 600; color: var(--text-secondary, var(--text-muted)); }
html[data-focus-desktop="1"][data-fc-flash] .fc-flash { opacity: 1; transform: none; transition: opacity .3s, transform .7s var(--fc-ease); }
html[data-focus-desktop="1"] #messages .message-avatar, html[data-focus-desktop="1"] #messages .message-avatar-img { position: relative; z-index: 3; box-shadow: 0 0 0 3px var(--bg-primary); }
html[data-focus-desktop="1"] .fc-rail { position: absolute; z-index: 2; width: 4px; border-radius: 2px; background: var(--accent); pointer-events: none; display: none; box-shadow: 0 0 10px var(--accent-glow, transparent); }
html[data-focus-desktop="1"] #messages .fc-aimed { background: color-mix(in srgb, var(--accent) 14%, transparent) !important; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); border-radius: var(--radius-sm, 6px); }
html[data-focus-desktop="1"] #messages [data-msg-id] { cursor: pointer; }
html[data-focus-desktop="1"] #reply-bar { border-inline-start: 4px solid var(--accent); }
html[data-focus-desktop="1"] .fc-progress { display: flex; align-items: center; gap: 12px; padding: 2px 18px 12px; }
html[data-focus-desktop="1"] .fc-pips { flex: 1 1 auto; display: flex; gap: 4px; }
html[data-focus-desktop="1"] .fc-pips span { flex: 1 1 0; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--border) 80%, transparent); transition: background .5s; }
html[data-focus-desktop="1"] .fc-pips span.done { background: var(--success, var(--accent)); }
html[data-focus-desktop="1"] .fc-pips span.now { background: var(--accent); }
html[data-focus-desktop="1"] .fc-count { flex: 0 0 auto; font-size: 12px; color: var(--text-muted); }
.fc-side { position: fixed; top: 64px; bottom: 140px; width: var(--fc-side); z-index: 5; display: flex; flex-direction: column; gap: 10px; padding: 18px 18px 16px; box-sizing: border-box; border: 0; border-radius: var(--fc-r); background: var(--bg-secondary); color: var(--text-primary); font: inherit; text-align: start; cursor: pointer; opacity: .62; transform: scale(.96); transition: opacity .5s, transform .72s var(--fc-ease); overflow: hidden; box-shadow: 0 0 0 1px color-mix(in srgb, var(--border) 50%, transparent); }
.fc-side:hover, .fc-side:focus-visible { opacity: .82; transform: scale(.98); }
.fc-side.empty, html:not([data-focus-desktop="1"]) .fc-side { display: none; }
.fc-left { left: max(16px, calc((100vw - var(--fc-w)) / 2 - var(--fc-side) - 28px)); -webkit-mask-image: linear-gradient(to right, rgba(0, 0, 0, .2), #000 60%); mask-image: linear-gradient(to right, rgba(0, 0, 0, .2), #000 60%); }
.fc-right { right: max(16px, calc((100vw - var(--fc-w)) / 2 - var(--fc-side) - 28px)); -webkit-mask-image: linear-gradient(to left, rgba(0, 0, 0, .2), #000 60%); mask-image: linear-gradient(to left, rgba(0, 0, 0, .2), #000 60%); }
@media (max-width: 1239px) { .fc-side { display: none !important; } }
.fs-head { display: flex; flex-direction: column; gap: 4px; }
.fs-name { font-size: 17px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-tag { font-size: 12px; font-weight: 600; color: var(--text-secondary, var(--text-muted)); }
.fs-sub { font-size: 13px; color: var(--accent); }
.fs-lines { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; overflow: hidden; }
.fs-line { display: flex; flex-direction: column; gap: 2px; font-size: 14px; line-height: 1.4; color: var(--text-secondary, var(--text-primary)); }
.fs-line b { color: var(--text-primary); font-size: 13px; }
.fs-key, .fc-key kbd { align-self: flex-start; min-width: 20px; padding: 1px 6px; box-sizing: border-box; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 5px; color: var(--text-muted); font: 600 11px/17px var(--font-main, inherit); text-align: center; }
.fc-left .fs-key { align-self: flex-end; }
.fc-dock { position: fixed; z-index: 40; left: 50%; bottom: 16px; transform: translateX(-50%); padding: 8px 12px; border-radius: 20px; background: var(--bg-secondary); box-shadow: 0 10px 30px color-mix(in srgb, #000 28%, transparent), 0 0 0 1px color-mix(in srgb, var(--border) 60%, transparent); font-family: var(--font-main, inherit); }
.fc-row { display: flex; align-items: flex-end; gap: 6px; }
.fc-di { position: relative; flex: 0 0 auto; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 12px; background: transparent; color: var(--text-muted); display: flex; align-items: center; justify-content: center; cursor: pointer; transform-origin: 50% 100%; transition: transform .34s var(--fc-ease, ease), color .3s, background .3s; }
.fc-di::before { content: ''; position: absolute; left: -4px; right: -4px; top: -4px; bottom: -30px; }
.fc-di:hover { transform: translateY(-8px) scale(1.34); color: var(--text-primary); z-index: 3; }
.fc-di:hover + .fc-di, .fc-di:has(+ .fc-di:hover) { transform: translateY(-4px) scale(1.16); z-index: 2; }
.fc-di:hover + .fc-di + .fc-di, .fc-di:has(+ .fc-di + .fc-di:hover) { transform: translateY(-1px) scale(1.06); }
.fc-di.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
.fc-di:focus-visible, .fc-help-btn:focus-visible, .fc-side:focus-visible, .fa-row:focus-visible, .fa-chip:focus-visible, .fy-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fc-sep { width: 1px; height: 24px; margin: 0 6px 8px; border-radius: 0; background: var(--border); cursor: default; }
.fc-sep::before { display: none; }
.fc-sep:hover { transform: none; }
html[data-fc-voice] .fc-di[data-id="voice"] { color: var(--success, var(--accent)); }
.fc-badge { position: absolute; top: -2px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; background: var(--accent); color: var(--accent-text, #fff); font: 700 10px/16px var(--font-main, inherit); text-align: center; pointer-events: none; }
.fc-badge:empty:not(.dot) { display: none; }
.fc-badge.dot { min-width: 8px; width: 8px; height: 8px; padding: 0; top: 2px; right: 2px; }
.fc-me { width: 30px; height: 30px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 30%, var(--bg-tertiary)); color: var(--text-primary); font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; }
.fc-tip::after { content: attr(data-tip); position: absolute; z-index: 60; bottom: calc(100% + 9px); left: 50%; transform: translate(-50%, 4px); padding: 4px 8px; border-radius: 7px; background: var(--bg-tertiary); color: var(--text-primary); box-shadow: 0 4px 14px color-mix(in srgb, #000 30%, transparent), 0 0 0 1px var(--border); font: 600 10px/1.2 var(--font-main, inherit); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.fc-tip:hover::after { opacity: 1; transform: translate(-50%, 0); }
.fc-help-btn.fc-tip::after { left: auto; right: 0; transform: translateY(4px); font-size: 11px; }
.fc-help-btn.fc-tip:hover::after { transform: none; }
.fc-servers [data-haven-region="server-rail"] { display: flex !important; flex-direction: row !important; align-items: flex-end !important; gap: 6px !important; width: auto !important; height: auto !important; min-height: 0 !important; padding: 0 !important; border: 0 !important; background: none !important; position: static !important; overflow: visible !important; }
.fc-servers [data-haven-region="server-list"] { display: flex !important; flex-direction: row !important; align-items: flex-end; gap: 6px; width: auto !important; height: auto !important; position: static !important; overflow: visible !important; }
.fc-servers .server-icon, .fc-servers .server-rail-btn, .fc-servers [data-haven-region="server-rail"] > button { width: 40px !important; height: 40px !important; min-width: 40px; margin: 0 !important; transform-origin: 50% 100%; transition: transform .34s var(--fc-ease, ease); }
.fc-servers .server-icon:hover { transform: translateY(-8px) scale(1.3); }
.fc-servers .server-separator { width: 1px !important; height: 24px !important; margin: 0 4px 8px !important; }
.fc-help-btn { position: fixed; z-index: 40; right: 20px; bottom: 26px; width: 34px; height: 34px; border: 0; border-radius: 17px; background: var(--bg-secondary); color: var(--text-muted); box-shadow: 0 0 0 1px color-mix(in srgb, var(--border) 60%, transparent); font: 700 15px var(--font-main, inherit); cursor: pointer; }
.fc-help-btn:hover { color: var(--text-primary); }
html:not([data-focus-desktop="1"]) .fc-dock, html:not([data-focus-desktop="1"]) .fc-help-btn, html:not([data-focus-desktop="1"]) .fc-pop { display: none !important; }
.fc-pop { position: fixed; z-index: 50; left: 50%; bottom: 84px; width: 380px; max-height: min(62vh, 640px); box-sizing: border-box; display: none; flex-direction: column; overflow: hidden; border-radius: 18px; background: var(--bg-secondary); color: var(--text-primary); box-shadow: 0 24px 60px color-mix(in srgb, #000 40%, transparent), 0 0 0 1px var(--border); transform: translateX(-50%); font-family: var(--font-main, inherit); }
html[data-fc-pop] .fc-pop { display: flex; animation: fc-pop .32s var(--fc-ease, ease); }
html[data-fc-pop="help"] .fc-pop { left: auto; right: 20px; bottom: 72px; width: 300px; transform: none; }
@keyframes fc-pop { from { opacity: 0; translate: 0 10px; } }
.fc-pane { display: none; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px; }
html[data-fc-pop="activity"] .fc-pane[data-pane="activity"], html[data-fc-pop="dms"] .fc-pane[data-pane="dms"], html[data-fc-pop="channels"] .fc-pane[data-pane="channels"], html[data-fc-pop="people"] .fc-pane[data-pane="people"], html[data-fc-pop="you"] .fc-pane[data-pane="you"], html[data-fc-pop="help"] .fc-pane[data-pane="help"] { display: block; }
.fc-pane [data-haven-region] { position: static !important; width: auto !important; max-width: none !important; height: auto !important; max-height: none !important; flex: none !important; display: block !important; border: 0 !important; background: none !important; transform: none !important; }
.fc-pane [data-haven-region="context-sidebar"] { min-height: 200px; }
.fc-help .fc-key { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 4px; font-size: 13px; color: var(--text-secondary, var(--text-primary)); }
.fa-head { padding: 4px 6px 10px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
.fa-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 10px; }
.fa-chip { height: 28px; padding: 0 11px; border: 0; border-radius: 14px; background: var(--bg-tertiary); color: var(--text-secondary, var(--text-primary)); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.fa-chip.active { background: var(--accent); color: var(--accent-text, #fff); }
.fa-section { padding: 10px 6px 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
.fa-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 9px 8px; border: 0; border-radius: 12px; background: none; color: var(--text-primary); font: inherit; text-align: start; cursor: pointer; }
.fa-row:hover { background: var(--bg-hover, color-mix(in srgb, var(--accent) 8%, transparent)); }
.fa-row.unread { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.fa-avatar { flex: 0 0 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--accent) 22%, var(--bg-tertiary)); color: var(--text-primary); font-weight: 700; font-size: 13px; }
.fa-avatar[data-kind="unread"] { background: var(--bg-tertiary); color: var(--text-muted); }
.fa-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fa-top { display: flex; align-items: baseline; gap: 8px; }
.fa-who { flex: 1 1 auto; min-width: 0; font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-time, .fa-sub { font-size: 12px; color: var(--text-muted); }
.fa-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-text { font-size: 13px; color: var(--text-secondary, var(--text-primary)); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fa-dot { flex: 0 0 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--accent); }
.fa-empty { padding: 36px 12px; text-align: center; color: var(--text-muted); font-size: 13px; }
.fy-row { display: block; width: 100%; padding: 10px 12px; border: 0; border-radius: 10px; background: none; color: var(--text-primary); font: inherit; font-size: 14px; font-weight: 600; text-align: start; cursor: pointer; }
.fy-row:hover { background: var(--bg-hover, color-mix(in srgb, var(--accent) 8%, transparent)); }
.fc-banner { position: fixed; z-index: 45; left: 0; right: 0; top: 34vh; display: flex; flex-direction: column; align-items: center; gap: 14px; pointer-events: none; opacity: 0; transform: scale(1.06); transition: opacity .5s, transform .75s var(--fc-ease, ease); color: var(--text-primary); font: 800 30px var(--font-heading, var(--font-main, inherit)); }
.fc-banner-icon { width: 72px; height: 72px; border-radius: calc(var(--radius, 8px) * 2.75); background: var(--accent); color: var(--accent-text, #fff); display: flex; align-items: center; justify-content: center; font-size: 30px; box-shadow: 0 18px 50px var(--accent-glow, transparent); }
html[data-fc-enter] .fc-banner { animation: fc-banner 1.5s var(--fc-ease) both; }
html[data-fc-leave] .fc-banner { opacity: 1; transform: none; }
@keyframes fc-banner { 0%, 45% { opacity: 1; transform: none; } 100% { opacity: 0; transform: scale(1.06); } }
html[data-focus-desktop="1"][data-fc-enter] [data-haven-region="main"] { animation: fc-in 1.4s var(--fc-ease) both; }
@keyframes fc-in { 0%, 35% { opacity: 0; transform: translateY(-34px) scale(.97); filter: blur(7px); } 100% { opacity: 1; transform: none; filter: none; } }
html[data-focus-desktop="1"][data-fc-leave] [data-haven-region="main"], html[data-fc-leave] .fc-side { opacity: 0; transform: translateY(34px) scale(.97); filter: blur(7px); }
@media (prefers-reduced-motion: reduce) { html[data-focus-desktop="1"] *, .fc-side, .fc-dock *, .fc-banner { animation-duration: .01s !important; transition-duration: .01s !important; } }
`;
if (typeof module !== 'undefined') module.exports = FocusLayout;
if (typeof _win !== 'undefined') _win.FocusLayout = FocusLayout;

// Your own channel order (#5779). Anyone can arrange the sidebar for
// themselves; the server's order, which admins set, stays what everyone else
// sees and what new channels follow.
//
//   - categories can go in any order, and the channels without a category
//     move as one group the same way;
//   - a channel moves only within its own category;
//   - sub-channels stay under their parent and follow it.
//
// The order is kept on the account (user preference channel_order), so it
// follows you to every device. Channels and categories it does not mention
// (new ones) keep the server's order after the ones it does.
// Arrange mode is turned on with the ⇅ button by the Channels heading; while
// it is on, dragging changes only your order, never the server's.

const UNTAGGED = '__untagged__';
const catKey = (cat) => (cat ? String(cat).toLowerCase() : UNTAGGED);

// Sort a list by where each item stands in `order`; items not in it keep
// their current order after the ones that are.
function byOrder(items, order, keyOf) {
  if (!Array.isArray(order) || !order.length) return items;
  const rank = new Map(order.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.has(keyOf(item)) ? rank.get(keyOf(item)) : Infinity }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : (a.r < b.r ? -1 : 1)))
    .map(x => x.item);
}

export default {

_personalChannelOrder() {
  const raw = this._userPrefs?.channel_order;
  if (!raw) return null;
  if (this._personalOrderRaw === raw) return this._personalOrderParsed;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (err) { console.warn('[channel-order] unreadable saved order, using the server order', err.message); }
  this._personalOrderRaw = raw;
  this._personalOrderParsed = parsed && typeof parsed === 'object' ? parsed : null;
  return this._personalOrderParsed;
},

// The channels of each category in your order (_renderChannels calls this
// after its own sort).
_applyPersonalChannelOrder(parentChannels) {
  const o = this._personalChannelOrder();
  if (!o || !o.ch) return parentChannels;
  const groups = new Map();
  for (const ch of parentChannels) {
    const k = catKey(ch.category);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(ch);
  }
  for (const [k, list] of groups) groups.set(k, byOrder(list, o.ch[k], c => c.code));
  // Put them back in the slots their category held, so the category order
  // is decided only by _applyPersonalCategoryOrder.
  const next = new Map([...groups].map(([k, list]) => [k, list.slice()]));
  return parentChannels.map(ch => next.get(catKey(ch.category)).shift());
},

// The categories in your order ('' is the group of channels without one).
_applyPersonalCategoryOrder(sortedCats) {
  const o = this._personalChannelOrder();
  if (!o || !Array.isArray(o.cats)) return sortedCats;
  return byOrder(sortedCats, o.cats, cat => catKey(cat));
},

_saveChannelOrder(order) {
  const value = order ? JSON.stringify(order) : '';
  if (!this._userPrefs) this._userPrefs = {};
  if (value) {
    this._userPrefs.channel_order = value;
    this.socket.emit('set-preference', { key: 'channel_order', value });
  } else {
    delete this._userPrefs.channel_order;
    this.socket.emit('delete-preference', { key: 'channel_order' });
  }
  this._personalOrderRaw = null;
  this._renderChannels();
},

// What is on screen, read back as an order: categories (and the group with
// no category) as they appear, and each category's channels in turn.
_readSidebarOrder() {
  const list = document.getElementById('channel-list');
  const cats = [];
  const ch = {};
  if (!list) return { cats, ch };
  const seen = new Set();
  const addCat = (k) => { if (!seen.has(k)) { seen.add(k); cats.push(k); } };
  for (const el of document.querySelectorAll('#channel-list .category-label, #channel-list .channel-item:not(.sub-channel-item):not(.dm-item)')) {
    if (el.classList.contains('category-label')) { addCat(catKey(el.dataset.category)); continue; }
    if (!el.dataset.code) continue;
    const k = catKey(el.dataset.catGroup || '');
    addCat(k);
    (ch[k] = ch[k] || []).push(el.dataset.code);
  }
  return { cats, ch };
},

_setupPersonalChannelOrder() {
  const btn = document.getElementById('arrange-channels-btn');
  const list = document.getElementById('channel-list');
  if (!btn || !list || this._personalOrderBound) return;
  this._personalOrderBound = true;
  btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleArrangeMode(); });

  // While arranging, these run before the admins' own drag handling and stop
  // it, so a drag here never moves anything for everyone else.
  let drag = null;
  const isParentChannel = (el) => el && el.classList.contains('channel-item') &&
    !el.classList.contains('sub-channel-item') && !el.classList.contains('dm-item') && !!el.dataset.code;
  const target = (e) => e.target.closest?.('.category-label, .channel-item');
  list.addEventListener('dragstart', (e) => {
    if (!this._arranging) return;
    e.stopPropagation();
    const el = target(e);
    if (!el || !(el.classList.contains('category-label') || isParentChannel(el))) { e.preventDefault(); return; }
    drag = el.classList.contains('category-label')
      ? { type: 'cat', key: catKey(el.dataset.category) }
      : { type: 'ch', key: el.dataset.code, cat: catKey(el.dataset.catGroup || '') };
    el.classList.add('ch-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', drag.key); } catch { /* some browsers refuse custom drag data; the drag still works */ }
  }, true);
  const okTarget = (el) => {
    if (!drag || !el) return false;
    if (drag.type === 'cat') return el.classList.contains('category-label') || (isParentChannel(el) && !el.dataset.catGroup);
    return isParentChannel(el) && catKey(el.dataset.catGroup || '') === drag.cat && el.dataset.code !== drag.key;
  };
  list.addEventListener('dragover', (e) => {
    if (!this._arranging) return;
    e.stopPropagation();
    const el = target(e);
    if (okTarget(el)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  }, true);
  list.addEventListener('drop', (e) => {
    if (!this._arranging) return;
    e.stopPropagation();
    e.preventDefault();
    const el = target(e);
    const ok = okTarget(el);
    const d = drag;
    drag = null;
    if (!d || !ok) return;
    const after = e.clientY > el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
    const order = this._readSidebarOrder();
    if (d.type === 'ch') {
      const arr = (order.ch[d.cat] || []).filter(c => c !== d.key);
      let i = arr.indexOf(el.dataset.code);
      if (i === -1) return;
      if (after) i++;
      arr.splice(i, 0, d.key);
      order.ch[d.cat] = arr;
    } else {
      const toKey = el.classList.contains('category-label') ? catKey(el.dataset.category) : UNTAGGED;
      const arr = order.cats.filter(k => k !== d.key);
      let i = arr.indexOf(toKey);
      if (i === -1) return;
      if (after) i++;
      arr.splice(i, 0, d.key);
      order.cats = arr;
    }
    this._saveChannelOrder(order);
  }, true);
  list.addEventListener('dragend', (e) => {
    if (!this._arranging) return;
    e.stopPropagation();
    drag = null;
    list.querySelectorAll('.ch-dragging').forEach(x => x.classList.remove('ch-dragging'));
  }, true);
},

_toggleArrangeMode(on = !this._arranging) {
  this._arranging = !!on;
  document.getElementById('arrange-channels-btn')?.classList.toggle('active', this._arranging);
  this._renderChannels();
},

// Called at the end of _renderChannels: the bar at the top while arranging,
// and every channel and category draggable.
_decorateArrangeMode() {
  const list = document.getElementById('channel-list');
  if (!list) return;
  list.classList.toggle('arranging', !!this._arranging);
  list.querySelector('.arrange-bar')?.remove();
  if (!this._arranging) return;
  list.querySelectorAll('.category-label, .channel-item:not(.sub-channel-item):not(.dm-item)').forEach(el => el.setAttribute('draggable', 'true'));
  const bar = document.createElement('div');
  bar.className = 'arrange-bar';
  const esc = (s) => this._escapeHtml(String(s));
  bar.innerHTML = `<div class="arrange-bar-text">${esc(t('channels.arrange.hint'))}</div>
    <div class="arrange-bar-actions">
      <button type="button" class="btn-xs" data-arrange="reset"${this._personalChannelOrder() ? '' : ' disabled'}>${esc(t('channels.arrange.reset'))}</button>
      <button type="button" class="btn-xs btn-accent" data-arrange="done">${esc(t('channels.arrange.done'))}</button>
    </div>`;
  bar.querySelector('[data-arrange="done"]').addEventListener('click', (e) => { e.stopPropagation(); this._toggleArrangeMode(false); });
  bar.querySelector('[data-arrange="reset"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await this._showConfirmModal(t('channels.arrange.reset_confirm'), ''))) return;
    this._saveChannelOrder(null);
  });
  list.prepend(bar);
},

};

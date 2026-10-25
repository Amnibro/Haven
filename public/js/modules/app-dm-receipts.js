export default {
_setupDmReceipts() {
  if (this._dmReceiptsReady) return;
  this._dmReceiptsReady = true;
  this._dmReceipts = new Map();
  const views = () => [['messages', this.channels?.find(c => c.code === this.currentChannel)?.is_dm ? this.currentChannel : null], ['dm-pip-messages', this._activeDMPip || null]];
  const ask = (code, id) => this.socket.emit('get-dm-receipt', { code }, (r) => { if (!r || r.error) return; this._dmReceipts.set(code, r.off ? null : { ...r, asked: id }); this._paintDmReceipts(); });
  let timer = null;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => { for (const [, code] of views()) if (code) { const id = this._lastOwnDmId(code); const r = this._dmReceipts.get(code); if (id && (r === undefined || (r && r.asked !== id))) { this._dmReceipts.set(code, { read: 0, delivered: 0, ...(r || {}), asked: id }); ask(code, id); } } this._paintDmReceipts(); }, 150); };
  const watch = new MutationObserver((list) => { if (list.some(m => [...m.addedNodes, ...m.removedNodes].some(n => !(n.classList?.contains('dm-receipt'))))) changed(); });
  for (const [id] of views()) { const el = document.getElementById(id); if (el) watch.observe(el, { childList: true, subtree: true }); }
  this.socket.on('dm-receipt', (r) => { if (!r?.code) return; this._dmReceipts.set(r.code, { ...(this._dmReceipts.get(r.code) || {}), ...r }); this._paintDmReceipts(); });
  this.socket.on('connect', () => { this._dmReceipts.clear(); changed(); });
  this.socket.on('preferences', () => { this._applyDmsFirst(); this._syncDmPrefToggles(); });
  this.socket.on('preference-saved', (d) => { if (d?.key === 'read_receipts') { this._dmReceipts.clear(); changed(); } });
  const bind = (id, key, after) => document.getElementById(id)?.addEventListener('change', (e) => { if (!this._userPrefs) this._userPrefs = {}; this._userPrefs[key] = e.target.checked ? 'on' : 'off'; this.socket.emit('set-preference', { key, value: this._userPrefs[key] }); after(); });
  bind('dms-first-toggle', 'dms_first', () => this._applyDmsFirst());
  bind('read-receipts-toggle', 'read_receipts', () => {});
  this._applyDmsFirst();
  this._syncDmPrefToggles();
},
_lastOwnDmId(code) {
  const box = document.getElementById(code === this._activeDMPip ? 'dm-pip-messages' : 'messages');
  const last = box && [...box.querySelectorAll('[data-msg-id][data-user-id]')].filter(el => !el.closest('.dm-receipt')).pop();
  return last && Number(last.dataset.userId) === this.user?.id ? Number(last.dataset.msgId) || 0 : 0;
},
_paintDmReceipts() {
  document.querySelectorAll('.dm-receipt').forEach(el => el.remove());
  const paint = (boxId, code) => {
    const r = code && this._dmReceipts.get(code), id = code ? this._lastOwnDmId(code) : 0, box = document.getElementById(boxId);
    if (!r || !id || !box) return;
    const el = box.querySelector(`[data-msg-id="${id}"]`), tag = document.createElement('div');
    tag.className = 'dm-receipt';
    tag.textContent = t(r.read >= id ? 'dm_receipts.seen' : r.delivered >= id ? 'dm_receipts.delivered' : 'dm_receipts.sent');
    el?.append(tag);
  };
  paint('messages', this.channels?.find(c => c.code === this.currentChannel)?.is_dm ? this.currentChannel : null);
  paint('dm-pip-messages', this._activeDMPip || null);
},
_applyDmsFirst() {
  const split = document.getElementById('sidebar-split'), dm = document.getElementById('dm-pane'), ch = document.getElementById('channels-pane'), handle = document.getElementById('sidebar-split-handle');
  if (!split || !dm || !ch || !handle) return;
  const first = this._userPrefs?.dms_first === 'on';
  split.classList.toggle('dms-first', first);
  first ? (split.insertBefore(dm, ch), split.insertBefore(handle, ch)) : (split.insertBefore(ch, dm), split.insertBefore(handle, dm));
},
_syncDmPrefToggles() {
  const a = document.getElementById('dms-first-toggle'), b = document.getElementById('read-receipts-toggle');
  if (a) a.checked = this._userPrefs?.dms_first === 'on';
  if (b) b.checked = this._userPrefs?.read_receipts !== 'off';
},
};

// Keeps the chat feed still while it changes height.
//
// Messages grow after they are drawn: link preview cards arrive, video
// embeds open, encrypted pictures decrypt, role colors and reactions fill in.
// The message list turns off the browser's own scroll anchoring (it fought
// the hand-made corrections for loading older history), so every one of those
// pushed the feed under the reader. Pictures had their own fix in the lazy
// loader; everything else jumped.
//
// This watches every message for a change in height. Someone reading the
// newest messages stays at the bottom. Anyone else keeps the message they
// are looking at in the same place: on each scroll the top visible message
// and where it sits are noted, and when anything above it grows or shrinks
// the scroll moves by exactly that much. The correction runs after layout and
// before the next paint, so nothing visibly moves.

export default {

_setupFeedAnchor() {
  const sc = document.getElementById('messages');
  if (!sc || this._feedAnchor || typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return;
  const A = this._feedAnchor = { el: null, top: 0, heights: new WeakMap(), ro: null, mo: null };

  // The first message whose bottom is below the top edge of the box.
  const record = () => {
    const edge = sc.getBoundingClientRect().top + 1;
    A.el = null;
    for (const el of sc.querySelectorAll(':scope > [data-msg-id]')) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom <= edge) continue;
      A.el = el;
      A.top = r.top;
      return;
    }
  };

  const hold = () => {
    // Loading older history moves the scroll itself and realigns its own
    // anchor; leave that to it.
    if (this._suppressCoupleCheck) return;
    if (this._coupledToBottom && this._noMoreFuture !== false && !this._isForumFeed?.()) {
      sc.scrollTop = sc.scrollHeight;
      return;
    }
    if (!A.el || !A.el.isConnected || !sc.contains(A.el)) { record(); return; }
    const drift = A.el.getBoundingClientRect().top - A.top;
    if (Math.abs(drift) < 1) return;
    sc.scrollTop += drift;
    A.top = A.el.getBoundingClientRect().top;
  };

  A.ro = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
      const before = A.heights.get(e.target);
      A.heights.set(e.target, h);
      // The first report for a new message is its starting size, not a change.
      if (before !== undefined && Math.abs(before - h) >= 0.5) changed = true;
    }
    if (changed) hold();
  });

  const watch = (n) => { if (n.nodeType === 1 && n.dataset?.msgId) A.ro.observe(n); };
  const unwatch = (n) => { if (n.nodeType === 1) A.ro.unobserve(n); };
  sc.querySelectorAll(':scope > [data-msg-id]').forEach(watch);
  A.mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.removedNodes.forEach(unwatch);
      m.addedNodes.forEach(watch);
    }
  });
  A.mo.observe(sc, { childList: true });

  sc.addEventListener('scroll', () => { if (!this._suppressCoupleCheck) record(); }, { passive: true });
  window.addEventListener('resize', record);
  record();
},

};

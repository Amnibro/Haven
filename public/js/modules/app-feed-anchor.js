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
//
// "At the bottom" goes by where the feed was just before the change, not
// only by the coupling flag. The flag is set from scroll events, and some
// moves never send one (a jump to a message already on screen), so a reader
// looking at the newest message could have a reaction or a picture push it
// out of view. Threads, forum topics and the DM window get the same rule.

// How close to the end counts as reading the newest messages.
const FEED_STICK_PX = 40;

export default {

// Brings a message to the middle of its list: a reply's original, a quote's
// source. The jump is instant. A smooth scroll was cancelled the moment the
// feed corrected for a picture or preview growing above it on the way, so
// it stopped partway and took two or three clicks to arrive. Afterwards the
// message is kept in the middle while what is around it finishes loading,
// until the reader scrolls themselves.
_scrollToMessage(el) {
  if (!el || !el.isConnected) return;
  const sc = el.closest('#messages, #thread-messages, #dm-pip-messages') || el.parentElement;
  // A message taller than the list (a big picture, a grid of them) lines up
  // its top instead, so its name and the start of the picture show.
  const block = () => (sc && el.getBoundingClientRect().height > sc.clientHeight * 0.9 ? 'start' : 'center');
  el.scrollIntoView({ block: block() });
  if (!sc) return;
  if (this._jumpSettle) this._jumpSettle();
  const until = performance.now() + 1500;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) sc.removeEventListener(ev, stop, true);
    if (this._jumpSettle === stop) this._jumpSettle = null;
  };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) sc.addEventListener(ev, stop, { capture: true, passive: true });
  this._jumpSettle = stop;
  const tick = (now) => {
    if (done) return;
    if (!el.isConnected || now > until) { stop(); return; }
    const r = el.getBoundingClientRect();
    const box = sc.getBoundingClientRect();
    const mode = block();
    const off = mode === 'start' ? r.top - box.top : (r.top + r.height / 2) - (box.top + box.height / 2);
    if (Math.abs(off) > box.height * 0.25) el.scrollIntoView({ block: mode });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
},

// Whether a box stays at its end through a change in height. gapBefore is
// how far from the end it was just before the change. A chat box is read
// from the bottom up; a blog topic opens at its top, so there the reader
// has to have scrolled down to the end themselves.
_feedShouldStick({ live, coupled, gapBefore, startsAtEnd, scrolled }) {
  if (!live) return false;
  if (coupled) return true;
  return gapBefore <= FEED_STICK_PX && (startsAtEnd || scrolled);
},

// How far from its end a box was before its content grew by `grew`. Two
// readings: the scroll position as it is now, and as it was last seen.
// Something may have moved the scroll since (the picture loader holding its
// place), or the browser may have clamped it without saying so. The larger
// of the two is used, so a doubtful case keeps the reader where they are.
_feedGapBefore(sc, grew, lastTop) {
  const height = sc.scrollHeight - grew;
  const now = height - sc.scrollTop - sc.clientHeight;
  const seen = typeof lastTop === 'number' ? height - lastTop - sc.clientHeight : now;
  return Math.max(now, seen);
},

// The main feed shows its newest message, whatever the coupling flag says.
// The flag only changes on scroll events, so a jump to a message already on
// screen, or a scroll the browser never reported, can leave it stale.
_feedAtEnd() {
  const sc = document.getElementById('messages');
  if (!sc || this._noMoreFuture === false || this._isForumFeed?.()) return false;
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight <= FEED_STICK_PX;
},

_setupFeedAnchor() {
  const sc = document.getElementById('messages');
  if (!sc || this._feedAnchor || typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return;
  this._feedAnchor = this._watchFeedBox(sc, true);
  // A thread, a forum topic and the DM window are read the same way. The
  // browser's own scroll anchoring is on there, so they only need help
  // staying at the bottom.
  for (const id of ['thread-messages', 'dm-pip-messages']) {
    const box = document.getElementById(id);
    if (box) this._watchFeedBox(box, false);
  }
},

_watchFeedBox(sc, main) {
  const A = { el: null, top: 0, st: sc.scrollTop, heights: new WeakMap(), ro: null, mo: null };

  // The first message whose bottom is below the top edge of the box.
  const record = () => {
    A.st = sc.scrollTop;
    if (!main) return;
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

  const stick = () => {
    sc.scrollTop = sc.scrollHeight;
    A.st = sc.scrollTop;
  };

  const hold = (grew) => {
    // A message whose edit box is being dragged taller keeps its top where
    // it is, so the box visibly grows downward. Sticking to the bottom here
    // slid the message up under the pointer instead.
    const pin = this._feedPinnedEdit;
    if (pin && pin.el.isConnected && sc.contains(pin.el)) {
      const drift = pin.el.getBoundingClientRect().top - pin.top;
      if (Math.abs(drift) >= 1) sc.scrollTop += drift;
      A.st = sc.scrollTop;
      return;
    }
    const gapBefore = this._feedGapBefore(sc, grew, A.st);
    if (!main) {
      const blog = sc.id === 'thread-messages' && !!this._forumBlogThread;
      if (this._feedShouldStick({ live: true, coupled: false, gapBefore, startsAtEnd: !blog, scrolled: A.st > 0 })) stick();
      else A.st = sc.scrollTop;
      return;
    }
    // Loading older history moves the scroll itself and realigns its own
    // anchor; leave that to it.
    if (this._suppressCoupleCheck) return;
    const live = this._noMoreFuture !== false && !this._isForumFeed?.();
    if (this._feedShouldStick({ live, coupled: this._coupledToBottom, gapBefore, startsAtEnd: true })) {
      // At the bottom is coupled, even when no scroll event said so.
      this._coupledToBottom = true;
      stick();
      return;
    }
    if (!A.el || !A.el.isConnected || !sc.contains(A.el)) { record(); return; }
    const drift = A.el.getBoundingClientRect().top - A.top;
    A.st = sc.scrollTop;
    if (Math.abs(drift) < 1) return;
    sc.scrollTop += drift;
    A.st = sc.scrollTop;
    A.top = A.el.getBoundingClientRect().top;
  };

  A.ro = new ResizeObserver((entries) => {
    // A closed thread or DM window reports every message at no height; the
    // sizes start over when it opens again.
    if (sc.clientHeight <= 0) {
      for (const e of entries) A.heights.delete(e.target);
      return;
    }
    let grew = 0;
    let changed = false;
    for (const e of entries) {
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
      const before = A.heights.get(e.target);
      A.heights.set(e.target, h);
      // The first report for a new message is its starting size, not a change.
      if (before !== undefined && Math.abs(before - h) >= 0.5) {
        changed = true;
        grew += h - before;
      }
    }
    if (changed) hold(grew);
  });

  // The main feed's messages are its children. A forum topic nests its
  // pieces and comments in sections, so there every child counts; a child
  // laid over the list (a floating button) takes no room and is left out.
  const counts = (n) => {
    if (n.nodeType !== 1) return false;
    if (main) return !!n.dataset?.msgId;
    const pos = getComputedStyle(n).position;
    return pos !== 'absolute' && pos !== 'fixed';
  };
  const watch = (n) => { if (counts(n)) A.ro.observe(n); };
  const unwatch = (n) => { if (n.nodeType === 1) A.ro.unobserve(n); };
  [...sc.children].forEach(watch);
  A.mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.removedNodes.forEach(unwatch);
      m.addedNodes.forEach(watch);
    }
    // Drawing a channel or adding a message usually scrolls in the same
    // breath, and a scroll event may not follow before the next change
    // (a window in the background gets few frames).
    A.st = sc.scrollTop;
  });
  A.mo.observe(sc, { childList: true });

  sc.addEventListener('scroll', () => {
    if (main && this._suppressCoupleCheck) { A.st = sc.scrollTop; return; }
    record();
  }, { passive: true });
  window.addEventListener('resize', record);
  record();
  return A;
},

};

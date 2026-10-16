// A thread open in the side panel shares the window with the chat instead
// of covering it: the chat column ends where the panel begins, so its
// messages wrap beside the thread. The panel still sits over the member list,
// as it always has. A thread popped out (PiP) floats on top as before, and a
// forum topic opened full width keeps its own layout (app-forum.js).
//
// The panel is fixed to the window and can be dragged wider, so the room it
// needs is measured rather than assumed. On a window too narrow to leave the
// chat a usable width, the panel covers it as it did before.

const MIN_CHAT_WIDTH = 360;

export default {

_setupThreadDock() {
  const panel = document.getElementById('thread-panel');
  const main = document.querySelector('.main');
  if (!panel || !main) return;
  let queued = false;
  const sync = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      this._syncThreadDock();
    });
  };
  // Opened, closed, popped out, switched to a forum topic, or dragged wider.
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
  // The slide-in moves the panel with a transform, which no resize reports.
  panel.addEventListener('animationend', sync);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(sync);
    ro.observe(panel);
    // The member list collapsing or being dragged moves the chat's edge.
    ro.observe(main);
  }
  window.addEventListener('resize', sync);
  this._syncThreadDock();
},

_threadDocked(panel) {
  return getComputedStyle(panel).display !== 'none'
    && !panel.classList.contains('pip')
    && !panel.classList.contains('thread-panel-forum');
},

_syncThreadDock() {
  const panel = document.getElementById('thread-panel');
  const main = document.querySelector('.main');
  if (!panel || !main) return;
  let margin = 0;
  if (this._threadDocked(panel)) {
    // Measured as if the chat had no margin yet, so the answer settles
    // instead of chasing the margin it just set.
    const current = parseFloat(main.style.marginRight) || 0;
    const r = main.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const right = r.right + current;
    const overlap = Math.round(right - p.left);
    if (overlap > 0 && right - r.left - overlap >= MIN_CHAT_WIDTH) margin = overlap;
  }
  const next = margin ? `${margin}px` : '';
  if (main.style.marginRight !== next) main.style.marginRight = next;
  document.body.classList.toggle('thread-docked', !!margin);
},

};

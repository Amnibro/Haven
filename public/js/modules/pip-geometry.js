// Where a pop-out (the DM and thread PiP panels) sits, and what is remembered.
//
// The saved rect is what the user chose. A window smaller than the pop-out
// only shrinks and moves it on screen, and that is never written back, so the
// saved size and position return when the window grows again. Only the
// user's own drag (position) or resize (size) changes what is saved.
//
// Pure, with no DOM, so it can be tested on its own.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (Number.isFinite(v) ? v : null);

// saved: the remembered rect (or null). o: viewW and viewH (the space the
// pop-out may use), minW, maxW, minH, the default width and height, and the
// default gap to the right and bottom edges for a pop-out with no saved spot.
export function fitPiPRect(saved, o) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const maxW = Math.min(o.maxW, o.viewW - 28);
  const maxH = Math.max(o.minH, o.viewH - 28);
  const width = Math.round(clamp(num(s.width) || o.width, o.minW, maxW));
  const height = Math.round(clamp(num(s.height) || o.height, o.minH, maxH));
  const left = num(s.left) ?? o.viewW - width - o.gapX;
  const top = num(s.top) ?? o.viewH - height - o.gapY;
  return {
    left: Math.round(Math.max(0, Math.min(o.viewW - width, left))),
    top: Math.round(Math.max(0, Math.min(o.viewH - height, top))),
    width,
    height,
  };
}

// What to remember after the user moved ('move') or resized ('resize') the
// pop-out. A move keeps the saved size and a resize keeps the saved spot, so
// neither picks up the squeeze a small window put on the other.
export function rectToSave(saved, current, change) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const keep = (key) => num(s[key]) ?? Math.round(current[key]);
  const take = (key) => Math.round(current[key]);
  return change === 'move'
    ? { left: take('left'), top: take('top'), width: keep('width'), height: keep('height') }
    : { left: keep('left'), top: keep('top'), width: take('width'), height: take('height') };
}

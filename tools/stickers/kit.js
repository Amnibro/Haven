'use strict';

// Drawing kit for Haven's built-in stickers. Every sticker is plain SVG built
// from these helpers so the whole set shares one look: a dark ink outline, flat
// colour with one shade tone, a white die-cut border and a soft drop shadow.
// No fonts, filters or masks are used, so a browser, AndroidSVG and a PNG
// render all match.

const INK = '#2b2141';
const SW = 7;          // ink outline width
const BORDER = 9;      // die-cut border, each side of the outline
const SHADOW = 6;      // shadow drop, in viewBox units

// [light, shade] pairs. Small on purpose: every sticker draws from this list.
const C = {
  yellow: ['#ffd23f', '#f5a524'],
  red: ['#ff5468', '#d9304c'],
  orange: ['#ff9233', '#ea6a1f'],
  blue: ['#59b9ff', '#2f86e6'],
  green: ['#4cdc85', '#1fae5c'],
  purple: ['#9d84ff', '#6b4fdb'],
  pink: ['#ff9fc4', '#f0679a'],
  white: ['#ffffff', '#d9d4e8'],
  gray: ['#c9c3db', '#9a92b4'],
  brown: ['#d58c4c', '#a2602f'],
  dark: ['#4d4170', '#2b2141'],
  teal: ['#45e3c8', '#1aa893'],
};

const r1 = (n) => Math.round(n * 10) / 10;
const num = (n) => String(r1(n)).replace(/^0\./, '.').replace(/^-0\./, '-.');

function attrs(a) {
  return Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${typeof v === 'number' ? num(v) : v}"`).join('');
}

// A shape: { t: tag, a: geometry attrs, f: fill, s: stroke colour, w: stroke
// width, n: true when it stays out of the die-cut silhouette, x: extra attrs }.
const shape = (t, a, o = {}) => ({ t, a, ...o });

// Filled shape with an ink outline and a shade tone: the shade fills the
// whole shape, the light colour is the same shape shrunk toward the upper
// left, and the outline is drawn last so the edges stay crisp.
function toon(t, a, [light, shade], o = {}) {
  const [cx, cy] = o.c || [128, 128];
  const k = o.k ?? 0.86;
  const [dx, dy] = o.off || [-3, -4];
  const tr = `translate(${num(cx + dx - k * cx)} ${num(cy + dy - k * cy)}) scale(${k})`;
  const out = [shape(t, a, { f: shade, n: o.n })];
  if (light !== shade) out.push(shape(t, a, { f: light, n: true, x: { transform: tr } }));
  out.push(shape(t, a, { f: 'none', s: INK, w: o.w ?? SW, n: true }));
  return out;
}

// Same as toon, for circles: the light disc is inset by `inset` and nudged.
function ball(cx, cy, r, [light, shade], o = {}) {
  const inset = o.inset ?? Math.max(6, r * 0.13);
  const [dx, dy] = o.off || [-inset * 0.42, -inset * 0.55];
  return [
    shape('circle', { cx, cy, r }, { f: shade, n: o.n }),
    shape('circle', { cx: cx + dx, cy: cy + dy, r: r - inset }, { f: light, n: true }),
    shape('circle', { cx, cy, r }, { f: 'none', s: INK, w: o.w ?? SW, n: true }),
  ];
}

// Single colour fill with an ink outline.
const flat = (t, a, fill, o = {}) => shape(t, a, { f: fill, s: o.s === undefined ? INK : o.s, w: o.w ?? SW, n: o.n, x: o.x });

// A thick coloured stroke with an ink edge around it (lettering, checks, arms).
function stroke(d, color, w, o = {}) {
  const edge = o.edge ?? 5;
  return [
    shape('path', { d }, { f: 'none', s: INK, w: w + edge * 2, n: o.n, x: o.x }),
    shape('path', { d }, { f: 'none', s: color, w, n: true, x: o.x }),
  ];
}

// Plain ink line or fill (eyes, mouths, creases). Never part of the silhouette.
const ink = (d, w = SW, o = {}) => shape('path', { d }, { f: 'none', s: o.color || INK, w, n: true, x: o.x });
const fillInk = (t, a, color = INK, o = {}) => shape(t, a, { f: color, n: true, x: o.x });

// A highlight: a soft white blob.
const shine = (cx, cy, rx, ry, rot = -30, op = 0.7) => shape('ellipse', { cx, cy, rx, ry }, { f: '#fff', n: true, x: { transform: `rotate(${rot} ${cx} ${cy})`, opacity: op } });

function paint(s) {
  const a = { ...s.a };
  const p = {};
  if (s.f !== undefined) p.fill = s.f;
  if (s.s) { p.stroke = s.s; p['stroke-width'] = s.w; }
  return `<${s.t}${attrs(a)}${attrs(p)}${attrs(s.x || {})}/>`;
}

// The silhouette copy: geometry only, its stroke widened by the border.
function sil(s) {
  const w = (s.s ? s.w : 0) + BORDER * 2;
  const p = { 'stroke-width': w };
  if (s.f === 'none') p.fill = 'none';
  const x = { ...(s.x || {}) };
  delete x.opacity;
  return `<${s.t}${attrs(s.a)}${attrs(p)}${attrs(x)}/>`;
}

// A part is { shapes, cls, origin, anim } where cls names a CSS animation.
// Parts that share a class move together, die-cut border and shadow included.
function sticker(parts, o = {}) {
  parts = parts.map((p) => (Array.isArray(p) ? { shapes: p } : p));
  const groups = [];
  for (const p of parts) {
    const chunk = { tr: p.tr, shapes: p.shapes.flat(Infinity).filter(Boolean) };
    let g = groups[groups.length - 1];
    if (!g || g.cls !== (p.cls || '')) { g = { cls: p.cls || '', chunks: [] }; groups.push(g); }
    g.chunks.push(chunk);
  }
  const wrap = (cls, inner) => (cls ? `<g class="${cls}">${inner}</g>` : inner);
  const emit = (chunks, fn, pick) => chunks.map((c) => {
    const body = c.shapes.filter(pick).map(fn).join('');
    return !body ? '' : c.tr ? `<g transform="${c.tr}">${body}</g>` : body;
  }).join('');
  let defs = '';
  let shadow = '';
  let border = '';
  let art = '';
  groups.forEach((g, i) => {
    const silBody = emit(g.chunks, sil, (s) => !s.n);
    if (silBody) {
      defs += `<g id="o${i}">${silBody}</g>`;
      shadow += wrap(g.cls, `<use xlink:href="#o${i}"/>`);
      border += wrap(g.cls, `<use xlink:href="#o${i}"/>`);
    }
    art += wrap(g.cls, emit(g.chunks, paint, () => true));
  });
  const css = o.css ? `<style>${o.css}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 256 256" width="256" height="256">${css}`
    + `<defs>${defs}</defs>`
    + `<g id="still" stroke-linecap="round" stroke-linejoin="round"${o.fit ? ` transform="${o.fit}"` : ''}>`
    + `<g fill="${INK}" stroke="${INK}" opacity=".22" transform="translate(0 ${SHADOW})">${shadow}</g>`
    + `<g fill="#fff" stroke="#fff">${border}</g>`
    + art
    + `</g></svg>`;
}

// Overlapping circles fused into one outlined blob (clouds, smoke, puffs):
// every circle with a doubled ink edge first, then every fill on top, so only
// the outer edge of the union stays inked.
function blob(circles, [light, shade], o = {}) {
  const w = (o.w ?? 7) * 2;
  return [
    circles.map(([cx, cy, r]) => shape('circle', { cx, cy, r }, { f: shade, s: INK, w, n: o.n })),
    circles.map(([cx, cy, r]) => shape('circle', { cx, cy, r }, { f: shade, n: true })),
    light === shade ? [] : circles.map(([cx, cy, r]) => shape('circle', { cx: cx - r * 0.12, cy: cy - r * 0.16, r: r * 0.8 }, { f: light, n: true })),
  ];
}

// Looping animation CSS. It only runs when the viewer has not asked for less
// motion, and `#still` in the URL (sticker.svg#still) stops it too, which is
// how Haven's own Reduce motion setting shows the resting frame.
function anim(rules) {
  const body = rules.map(([cls, kf, dur, origin, timing = 'ease-in-out']) =>
    `.${cls}{animation:${cls} ${dur}s ${timing} infinite;transform-origin:${origin}}@keyframes ${cls}{${kf}}`).join('');
  return `@media (prefers-reduced-motion:no-preference){${body}}#still:target *{animation:none}`;
}

// Rounded regular polygon path (the Haven hexagon).
function roundPoly(cx, cy, R, n, rot, rad) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (rot + (360 / n) * i) * Math.PI / 180;
    pts.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]);
  }
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const p1 = [p[0] + (a[0] - p[0]) * rad / la, p[1] + (a[1] - p[1]) * rad / la];
    const p2 = [p[0] + (b[0] - p[0]) * rad / lb, p[1] + (b[1] - p[1]) * rad / lb];
    d += `${i ? 'L' : 'M'}${num(p1[0])} ${num(p1[1])}Q${num(p[0])} ${num(p[1])} ${num(p2[0])} ${num(p2[1])}`;
  }
  return d + 'Z';
}

// Capsule (rounded bar) from (x1,y1) to (x2,y2), as a path.
function capsule(x1, y1, x2, y2, r) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const nx = -Math.sin(a) * r;
  const ny = Math.cos(a) * r;
  return `M${num(x1 + nx)} ${num(y1 + ny)}L${num(x2 + nx)} ${num(y2 + ny)}A${num(r)} ${num(r)} 0 0 0 ${num(x2 - nx)} ${num(y2 - ny)}L${num(x1 - nx)} ${num(y1 - ny)}A${num(r)} ${num(r)} 0 0 0 ${num(x1 + nx)} ${num(y1 + ny)}Z`;
}

const rrect = (x, y, w, h, r) => `M${num(x + r)} ${num(y)}H${num(x + w - r)}Q${num(x + w)} ${num(y)} ${num(x + w)} ${num(y + r)}V${num(y + h - r)}Q${num(x + w)} ${num(y + h)} ${num(x + w - r)} ${num(y + h)}H${num(x + r)}Q${num(x)} ${num(y + h)} ${num(x)} ${num(y + h - r)}V${num(y + r)}Q${num(x)} ${num(y)} ${num(x + r)} ${num(y)}Z`;

module.exports = { blob, INK, SW, BORDER, C, num, shape, toon, ball, flat, stroke, ink, fillInk, shine, sticker, anim, roundPoly, capsule, rrect };

'use strict';

// Haven's built-in sticker art. Each entry draws one sticker with the kit in
// kit.js; build.js turns this file into public/stickers/. Servers notice a
// changed drawing by its hash and update their copy, unless an admin replaced
// or edited it.

const { blob, INK, C, shape, toon, ball, flat, stroke, ink, fillInk, shine, sticker, anim, roundPoly, capsule, rrect } = require('./kit');

// ── Faces ─────────────────────────────────────────────────
const face = (col = C.yellow, cx = 128, cy = 128, r = 98) => ball(cx, cy, r, col);
const cheeks = (y = 150, dx = 58, cx = 128, op = 0.55) => [
  fillInk('ellipse', { cx: cx - dx, cy: y, rx: 15, ry: 9 }, '#ff7a9a', { x: { opacity: op } }),
  fillInk('ellipse', { cx: cx + dx, cy: y, rx: 15, ry: 9 }, '#ff7a9a', { x: { opacity: op } }),
];
function dotEyes(y = 108, dx = 34, cx = 128, rx = 11, ry = 16, look = [0, 0]) {
  return [-1, 1].flatMap((s) => [
    fillInk('ellipse', { cx: cx + s * dx + look[0], cy: y + look[1], rx, ry }),
    fillInk('circle', { cx: cx + s * dx + look[0] - rx * 0.3, cy: y + look[1] - ry * 0.4, r: rx * 0.38 }, '#fff'),
  ]);
}
// ^ ^ happy arcs
const happyEyes = (y = 112, dx = 34, cx = 128, w = 16, h = 14, sw = 9) => [-1, 1].map((s) => ink(`M${cx + s * dx - w} ${y + h * 0.4}Q${cx + s * dx} ${y - h * 1.3} ${cx + s * dx + w} ${y + h * 0.4}`, sw));
// > < squeezed shut
const squintEyes = (y = 110, dx = 36, cx = 128, sw = 9) => [
  ink(`M${cx - dx - 14} ${y - 13}L${cx - dx + 12} ${y}L${cx - dx - 14} ${y + 13}`, sw),
  ink(`M${cx + dx + 14} ${y - 13}L${cx + dx - 12} ${y}L${cx + dx + 14} ${y + 13}`, sw),
];
// u u closed, relaxed
const closedEyes = (y = 112, dx = 34, cx = 128, w = 16, sw = 8) => [-1, 1].map((s) => ink(`M${cx + s * dx - w} ${y}Q${cx + s * dx} ${y + 14} ${cx + s * dx + w} ${y}`, sw));
const brow = (x1, y1, x2, y2, sw = 8) => ink(`M${x1} ${y1}Q${(x1 + x2) / 2} ${Math.min(y1, y2) - 6} ${x2} ${y2}`, sw);
const tear = (x, y, s = 1, col = C.blue) => toon('path', { d: `M${x} ${y - 22 * s}C${x + 4 * s} ${y - 10 * s} ${x + 13 * s} ${y - 2 * s} ${x + 13 * s} ${y + 7 * s}A${13 * s} ${13 * s} 0 0 1 ${x - 13 * s} ${y + 7 * s}C${x - 13 * s} ${y - 2 * s} ${x - 4 * s} ${y - 10 * s} ${x} ${y - 22 * s}Z` }, col, { c: [x, y], k: 0.7, off: [-2, -2], w: 6 });
// Open laughing mouth: dark inside, tongue, a row of teeth.
function openMouth(cx = 128, y = 140, w = 46, h = 50, o = {}) {
  const d = `M${cx - w} ${y}Q${cx} ${y + 8} ${cx + w} ${y}Q${cx + w * 0.92} ${y + h} ${cx} ${y + h}Q${cx - w * 0.92} ${y + h} ${cx - w} ${y}Z`;
  const out = [shape('path', { d }, { f: '#5b2338', s: INK, w: 7, n: true })];
  if (o.tongue !== false) out.push(fillInk('path', { d: `M${cx - w * 0.5} ${y + h * 0.82}Q${cx} ${y + h * 0.5} ${cx + w * 0.5} ${y + h * 0.82}Q${cx} ${y + h * 1.04} ${cx - w * 0.5} ${y + h * 0.82}Z` }, '#ff6f8e'));
  if (o.teeth !== false) out.push(fillInk('path', { d: `M${cx - w * 0.86} ${y + 4}Q${cx} ${y + 11} ${cx + w * 0.86} ${y + 4}L${cx + w * 0.8} ${y + 14}Q${cx} ${y + 20} ${cx - w * 0.8} ${y + 14}Z` }, '#fff'));
  out.push(shape('path', { d }, { f: 'none', s: INK, w: 7, n: true }));
  return out;
}
const smile = (cx = 128, y = 150, w = 34, h = 22, sw = 9) => ink(`M${cx - w} ${y}Q${cx} ${y + h * 1.6} ${cx + w} ${y}`, sw);
const frown = (cx = 128, y = 168, w = 30, h = 16, sw = 9) => ink(`M${cx - w} ${y}Q${cx} ${y - h * 1.6} ${cx + w} ${y}`, sw);

// ── Hands ─────────────────────────────────────────────────
// A mitten hand: a palm with stacked finger bars. Drawn in a local frame
// pointing up with the wrist at (0,0); `place` rotates it into position.
const place = (x, y, rot = 0, s = 1) => `translate(${x} ${y}) rotate(${rot}) scale(${s})`;

// ── Lettering ─────────────────────────────────────────────
// Single-stroke letters on an 80-unit cap height, drawn as a fat round pen.
const GLYPHS = {
  A: [56, 'M2 74L28 6L54 74M13 48H43'],
  B: [52, 'M6 74V6H28C42 6 48 13 48 23C48 33 41 39 28 39H6M28 39C44 39 50 47 50 57C50 68 42 74 30 74H6'],
  C: [52, 'M49 18C44 10 37 6 28 6C13 6 4 21 4 40C4 59 13 74 28 74C37 74 44 70 49 62'],
  E: [48, 'M46 6H6V74H46M6 40H38'],
  F: [46, 'M46 6H6V74M6 39H38'],
  G: [56, 'M50 17C45 10 37 6 29 6C13 6 4 21 4 40C4 59 13 74 29 74C44 74 53 64 53 49V44H33'],
  I: [12, 'M6 6V74'],
  K: [52, 'M6 6V74M48 6L8 47M21 34L50 74'],
  L: [44, 'M6 4V74H44'],
  M: [62, 'M5 74V6L31 48L57 6V74'],
  O: [58, 'M29 6C13 6 4 21 4 40C4 59 13 74 29 74C45 74 54 59 54 40C54 21 45 6 29 6Z'],
  P: [50, 'M6 74V6H28C42 6 48 14 48 26C48 38 42 45 28 45H6'],
  R: [52, 'M6 74V6H28C42 6 48 14 48 25C48 36 42 42 28 42H6M28 42L50 74'],
  T: [52, 'M2 6H50M26 6V74'],
  U: [54, 'M5 6V48C5 65 14 74 27 74C40 74 49 65 49 48V6'],
  V: [56, 'M2 6L28 74L54 6'],
  W: [66, 'M2 6L16 74L33 28L50 74L64 6'],
  Y: [54, 'M2 6L27 40L52 6M27 40V74'],
  1: [30, 'M6 20L22 6V74'],
  0: [50, 'M25 6C11 6 4 21 4 40C4 59 11 74 25 74C39 74 46 59 46 40C46 21 39 6 25 6Z'],
  '!': [12, 'M6 6V48M6 72V74'],
  Z: [52, 'M4 6H48L4 74H48'],
  '@': [70, 'M47 40C47 50 41 56 34 56C27 56 22 50 22 42C22 32 29 25 37 25C44 25 47 31 47 38V48C47 54 51 57 55 57C62 57 66 49 66 40C66 21 52 6 35 6C17 6 4 21 4 40C4 59 17 74 36 74C45 74 52 71 57 66'],
};
// Lay out text centred on (cx, cy) at `scale`; returns paths in viewBox units.
function word(text, cx, cy, scale = 1, gap = 14) {
  const glyphs = [...text].map((ch) => GLYPHS[ch]);
  const width = glyphs.reduce((sum, g) => sum + g[0], 0) + gap * (glyphs.length - 1);
  let x = -width / 2;
  const parts = [];
  for (const [w, d] of glyphs) {
    parts.push({ d, x });
    x += w + gap;
  }
  return parts.map(({ d, x: gx }) => ({ d, tr: `translate(${cx + gx * scale} ${cy - 40 * scale}) scale(${scale})` }));
}
// Fat lettering: ink edge for every glyph first, then the colour, so the
// letters fuse into one sticker word. Width is in glyph units.
function lettering(text, cx, cy, scale, color, o = {}) {
  const w = o.w ?? 16;
  const edge = o.edge ?? 6;
  const ps = word(text, cx, cy, scale, o.gap);
  return [
    ...ps.map((p) => shape('path', { d: p.d }, { f: 'none', s: INK, w: w + (edge * 2) / scale, x: { transform: p.tr } })),
    ...ps.map((p) => shape('path', { d: p.d }, { f: 'none', s: color, w, n: true, x: { transform: p.tr } })),
    ...(o.shine === false ? [] : ps.map((p) => shape('path', { d: p.d }, { f: 'none', s: '#fff', w: w * 0.28, n: true, x: { transform: `${p.tr} translate(-2.5 -3)`, opacity: 0.45 } }))),
  ];
}

// ── Mascot: Hex, the Haven hexagon ────────────────────────
// Body centred on (cx, cy); `mood` picks the face.
function hexBody(cx = 128, cy = 126, R = 84, o = {}) {
  const d = roundPoly(cx, cy, R, 6, -90, 22);
  return toon('path', { d }, o.col || C.purple, { c: [cx, cy], k: 0.84, off: [-4, -6] });
}
const hexFeet = (cx = 128, y = 210, dx = 30) => [-1, 1].map((s) => toon('path', { d: rrect(cx + s * dx - 18, y - 12, 36, 24, 12) }, C.purple, { c: [cx + s * dx, y], k: 0.7, off: [-1, -3] }));
const mitt = (x, y, r = 16) => ball(x, y, r, C.purple, { inset: 5 });
// `R` is the body's size, so the blush stays inside smaller bodies.
function hexFace(cx = 128, cy = 118, mood = 'happy', R = 84) {
  const out = [];
  if (mood === 'happy') out.push(dotEyes(cy - 6, 28, cx, 10, 14), smile(cx, cy + 26, 22, 14, 8));
  if (mood === 'grin') out.push(happyEyes(cy - 4, 28, cx, 13, 12, 8), openMouth(cx, cy + 18, 30, 34, { teeth: false }));
  if (mood === 'sleep') out.push(closedEyes(cy - 2, 28, cx, 13, 7), fillInk('ellipse', { cx, cy: cy + 30, rx: 8, ry: 10 }, '#5b2338'));
  if (mood === 'stern') out.push(dotEyes(cy - 2, 28, cx, 10, 12), ink(`M${cx - 44} ${cy - 30}L${cx - 16} ${cy - 18}`, 8), ink(`M${cx + 44} ${cy - 30}L${cx + 16} ${cy - 18}`, 8), ink(`M${cx - 16} ${cy + 30}Q${cx} ${cy + 24} ${cx + 16} ${cy + 30}`, 8));
  if (mood === 'shock') out.push(dotEyes(cy - 6, 28, cx, 11, 15), fillInk('ellipse', { cx, cy: cy + 30, rx: 11, ry: 14 }, '#5b2338'));
  if (mood === 'calm') out.push(closedEyes(cy - 4, 28, cx, 13, 7), smile(cx, cy + 24, 18, 12, 8));
  out.push(cheeks(cy + 16, Math.min(50, R * 0.6), cx, 0.6));
  return out;
}
const sparkle = (x, y, s = 1, col = '#ffd23f') => flat('path', { d: `M${x} ${y - 16 * s}Q${x + 3 * s} ${y - 3 * s} ${x + 16 * s} ${y}Q${x + 3 * s} ${y + 3 * s} ${x} ${y + 16 * s}Q${x - 3 * s} ${y + 3 * s} ${x - 16 * s} ${y}Q${x - 3 * s} ${y - 3 * s} ${x} ${y - 16 * s}Z` }, col, { w: 5 });

// A closed mitten in a local frame: wrist at (0,0), fingers up the -y axis.
// `thumb` is -1 (thumb on the left) or 1; place it with a part transform.
function mitten(col = C.yellow, o = {}) {
  const len = o.len ?? 112;
  const w = o.w ?? 66;
  const t = o.thumb ?? -1;
  const out = [];
  if (t) out.push(toon('path', { d: capsule(t * (w / 2 - 10), -len * 0.3, t * (w / 2 + 14), -len * 0.66, 14) }, col, { c: [t * (w / 2), -len * 0.5], k: 0.75, off: [-2, -2] }));
  out.push(toon('path', { d: rrect(-w / 2, -len, w, len, w * 0.45) }, col, { c: [0, -len / 2], k: 0.84, off: [-3, -4] }));
  if (o.creases !== false) out.push(ink(`M${-w / 6} ${-len + 8}V${-len + 34}M${w / 6} ${-len + 8}V${-len + 34}`, 5));
  if (o.cuff) out.push(toon('path', { d: rrect(-w / 2 - 6, -12, w + 12, 30, 10) }, o.cuff, { c: [0, 3], k: 0.8, off: [-2, -2] }));
  return out;
}
// An open hand, fingers spread, same local frame as mitten().
function openHand(col = C.yellow, o = {}) {
  const fingers = [[-27, -78, -38, -142], [-9, -84, -12, -156], [10, -84, 13, -154], [27, -76, 38, -134]];
  return [
    fingers.map(([x1, y1, x2, y2]) => toon('path', { d: capsule(x1, y1, x2, y2, 12) }, col, { c: [(x1 + x2) / 2, (y1 + y2) / 2], k: 0.7, off: [-2, -3] })),
    toon('path', { d: capsule(-30, -36, -64, -74, 13) }, col, { c: [-47, -55], k: 0.72, off: [-2, -3] }),
    toon('path', { d: rrect(-40, -96, 80, 98, 34) }, col, { c: [0, -47], k: 0.84, off: [-3, -4] }),
    o.cuff ? toon('path', { d: rrect(-46, -10, 92, 30, 10) }, o.cuff, { c: [0, 5], k: 0.8, off: [-2, -2] }) : [],
  ];
}
const motion = (d) => shape('path', { d }, { f: 'none', s: INK, w: 7 });
function thumbHand(flip) {
  const off = flip ? [3, 4] : [-3, -4];
  const fist = 'M98 112H168A14 14 0 0 1 168 140A14 14 0 0 1 168 168A14 14 0 0 1 168 196A14 14 0 0 1 168 224H98Q80 224 80 206V130Q80 112 98 112Z';
  return [
    toon('path', { d: rrect(34, 106, 48, 124, 12) }, C.blue, { c: [58, 168], k: 0.8, off }),
    toon('path', { d: fist }, C.yellow, { c: [126, 168], k: 0.86, off }),
    ink('M138 140H168M138 168H168M138 196H168', 6),
    toon('path', { d: capsule(104, 118, 114, 46, 22) }, C.yellow, { c: [109, 82], k: 0.8, off }),
  ];
}
// Party popper stripes: bands across the cone between fractions t1..t2.
function coneBand(tip, a, b, t1, t2) {
  const P = (q, t) => [tip[0] + (q[0] - tip[0]) * t, tip[1] + (q[1] - tip[1]) * t];
  const pts = [P(a, t1), P(a, t2), P(b, t2), P(b, t1)];
  return 'M' + pts.map((p) => `${Math.round(p[0])} ${Math.round(p[1])}`).join('L') + 'Z';
}
const heartPath = (cx, cy, s) => `M${cx} ${cy + 22 * s}C${cx - 14 * s} ${cy + 13 * s} ${cx - 24 * s} ${cy + 4 * s} ${cx - 24 * s} ${cy - 7 * s}C${cx - 24 * s} ${cy - 17 * s} ${cx - 16 * s} ${cy - 22 * s} ${cx - 9 * s} ${cy - 22 * s}C${cx - 4 * s} ${cy - 22 * s} ${cx - 1 * s} ${cy - 19 * s} ${cx} ${cy - 15 * s}C${cx + 1 * s} ${cy - 19 * s} ${cx + 4 * s} ${cy - 22 * s} ${cx + 9 * s} ${cy - 22 * s}C${cx + 16 * s} ${cy - 22 * s} ${cx + 24 * s} ${cy - 17 * s} ${cx + 24 * s} ${cy - 7 * s}C${cx + 24 * s} ${cy + 4 * s} ${cx + 14 * s} ${cy + 13 * s} ${cx} ${cy + 22 * s}Z`;
const starPath = (cx, cy, R, r, rot = -90, n = 5) => {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a = (rot + i * 180 / n) * Math.PI / 180;
    const rr = i % 2 ? r : R;
    d += `${i ? 'L' : 'M'}${Math.round((cx + rr * Math.cos(a)) * 10) / 10} ${Math.round((cy + rr * Math.sin(a)) * 10) / 10}`;
  }
  return d + 'Z';
};
// Speech/label plate behind lettering.
const plate = (x, y, w, h, col = C.white) => toon('path', { d: rrect(x, y, w, h, h / 2) }, col, { c: [x + w / 2, y + h / 2], k: 0.92, off: [-2, -3] });
const hexArm = (x1, y1, x2, y2) => toon('path', { d: capsule(x1, y1, x2, y2, 11) }, C.purple, { c: [(x1 + x2) / 2, (y1 + y2) / 2], k: 0.7, off: [-1, -2] });
const zzz = (x, y, s, col = C.blue[0]) => lettering('Z', x, y, s, col, { w: 14, edge: 5, shine: false });

// ── Stickers ──────────────────────────────────────────────
const HEART = 'M128 218C70 182 30 146 32 98C34 62 62 42 90 44C108 45 120 56 128 72C136 56 148 45 166 44C194 42 222 62 224 98C226 146 186 182 128 218Z';
// Each entry returns a renderer so build.js can pass the fitted transform.
const sticky = (shapes, css) => (o = {}) => sticker(shapes, { ...o, css: css && anim(css) });

const art = {
  // ── Reactions ──
  'thumbs-up': () => sticky([thumbHand(false)]),
  'thumbs-down': () => sticky([{ tr: 'rotate(180 128 128)', shapes: thumbHand(true) }]),

  heart: () => sticky([{ cls: 'b', shapes: [toon('path', { d: HEART }, C.red, { c: [128, 120], k: 0.84, off: [-5, -7] }), shine(76, 86, 16, 9, -40)] }],
    [['b', '0%,40%,100%{transform:scale(1)}12%{transform:scale(1.09)}24%{transform:scale(.97)}32%{transform:scale(1.05)}', 1.4, '128px 140px']]),

  fire: () => {
    const outer = 'M128 230C78 230 46 198 48 152C50 116 76 100 80 62C98 76 106 96 104 116C118 94 132 66 124 26C170 48 210 98 208 154C206 200 176 230 128 230Z';
    const mid = 'M128 222C98 222 76 202 78 172C80 148 96 138 100 114C112 128 114 142 112 154C124 140 134 120 130 96C160 114 182 146 180 178C178 206 158 222 128 222Z';
    const core = 'M128 222C110 222 98 210 99 192C100 176 112 168 116 152C126 164 128 174 126 184C134 178 140 168 140 156C154 168 160 182 158 196C156 212 144 222 128 222Z';
    return sticky([{ cls: 'f', shapes: [toon('path', { d: outer }, C.red, { c: [128, 140], k: 0.88, off: [-3, -2] }), shape('path', { d: mid }, { f: C.orange[0], n: true }), shape('path', { d: core }, { f: '#ffe066', n: true })] }],
      [['f', '0%,100%{transform:scale(1,1) skewX(0)}25%{transform:scale(1.03,.96) skewX(2deg)}50%{transform:scale(.98,1.05) skewX(-2deg)}75%{transform:scale(1.02,.98) skewX(1deg)}', 0.9, '128px 228px']]);
  },

  100: () => sticky([{ tr: 'skewX(-10) translate(22 0)', shapes: [
    lettering('100', 128, 104, 1.05, C.red[0], { w: 17, gap: 10 }),
    stroke('M44 172H212', C.red[0], 16, { edge: 6 }), stroke('M58 206H198', C.red[0], 16, { edge: 6 }),
  ] }]),

  check: () => sticky([[stroke('M58 134L106 182L202 80', C.green[1], 42, { edge: 7 }), ink('M58 134L106 182L202 80', 30, { color: C.green[0] }), ink('M66 132L104 168', 8, { color: '#fff', x: { opacity: 0.5 } })]]),

  nope: () => sticky([[stroke('M70 70L186 186M186 70L70 186', C.red[1], 42, { edge: 7 }), ink('M70 70L186 186M186 70L70 186', 30, { color: C.red[0] }), ink('M78 74L104 100M178 74L170 82', 8, { color: '#fff', x: { opacity: 0.5 } })]]),

  ok: () => sticky([[lettering('OK', 120, 134, 1.45, C.green[0], { w: 17, gap: 12 }), sparkle(214, 62, 1.1)]]),

  eyes: () => {
    const eye = (cx) => [
      toon('ellipse', { cx, cy: 128, rx: 50, ry: 70 }, C.white, { c: [cx, 128], k: 0.86, off: [-3, -6] }),
      fillInk('ellipse', { cx: cx - 22, cy: 140, rx: 22, ry: 30 }),
      fillInk('circle', { cx: cx - 30, cy: 128, r: 8 }, '#fff'),
    ];
    return sticky([[eye(80), eye(178)]]);
  },

  laugh: () => sticky([{ cls: 'j', shapes: [face(), squintEyes(104, 38), openMouth(128, 136, 52, 58), tear(42, 116, 0.9), tear(214, 116, 0.9)] }],
    [['j', '0%,100%{transform:rotate(0)}25%{transform:rotate(-5deg)}75%{transform:rotate(5deg)}', 0.5, '128px 200px']]),

  cry: () => sticky([[
    face(),
    ink('M70 92Q86 72 108 76', 8), ink('M186 92Q170 72 148 76', 8),
    closedEyes(112, 36, 128, 16, 8).map((x) => x),
    stroke('M92 124C88 150 96 178 88 214', C.blue[0], 16, { edge: 5, n: true }),
    stroke('M164 124C168 150 160 178 168 214', C.blue[0], 16, { edge: 5, n: true }),
    ink('M104 176Q116 162 128 172Q140 162 152 176', 8),
  ]]),

  'mind-blown': () => sticky([[
    ball(128, 154, 82, C.yellow),
    toon('path', { d: starPath(128, 70, 64, 40, -90, 9) }, [C.yellow[0], C.orange[0]], { c: [128, 66], k: 0.62, off: [0, 4] }),
    shape('path', { d: starPath(128, 74, 30, 18, -70, 9) }, { f: '#fff7d1', n: true }),
    ink('M74 138L90 132L104 140L118 130L128 138L140 130L152 140L166 132L182 138', 6),
    [-1, 1].map((s) => toon('ellipse', { cx: 128 + s * 32, cy: 166, rx: 18, ry: 21 }, C.white, { c: [128 + s * 32, 166], k: 0.85, off: [-1, -2], w: 6, n: true })),
    fillInk('circle', { cx: 96, cy: 168, r: 6 }), fillInk('circle', { cx: 160, cy: 168, r: 6 }),
    fillInk('ellipse', { cx: 128, cy: 210, rx: 12, ry: 13 }, '#5b2338'),
  ]]),

  party: () => {
    const tip = [40, 222];
    const a = [84, 98];
    const b = [160, 176];
    const cone = `M${tip}L${a}L${b}Z`;
    const confetti = [[150, 52, C.yellow[0], 20], [204, 74, C.blue[0], -30], [216, 130, C.green[0], 40], [118, 34, C.red[0], 60], [180, 108, C.pink[0], 0], [96, 70, C.teal[0], -50]];
    return sticky([
      [toon('path', { d: cone }, C.purple, { c: [96, 170], k: 0.82, off: [-3, 2] }),
        shape('path', { d: coneBand(tip, a, b, 0.42, 0.56) }, { f: C.yellow[0], n: true }),
        shape('path', { d: coneBand(tip, a, b, 0.72, 0.86) }, { f: C.yellow[0], n: true }),
        shape('path', { d: cone }, { f: 'none', s: INK, w: 7, n: true }),
        flat('path', { d: `M${a}L${b}` }, 'none', { w: 9 })],
      { cls: 'p', shapes: [
        stroke('M114 90C120 66 142 68 138 46', C.red[0], 10, { edge: 5 }),
        stroke('M152 132C172 120 184 140 208 130', C.blue[0], 10, { edge: 5 }),
        confetti.map(([x, y, col, r]) => flat('path', { d: rrect(x - 9, y - 6, 18, 12, 4) }, col, { w: 5, x: { transform: `rotate(${r} ${x} ${y})` } })),
        sparkle(206, 186, 0.9), sparkle(56, 64, 0.8),
      ] },
    ], [['p', '0%,55%,100%{transform:scale(1) rotate(0)}15%{transform:scale(.84) rotate(-6deg)}32%{transform:scale(1.07) rotate(2deg)}', 1.6, '96px 176px']]);
  },

  clap: () => sticky([
    [motion('M54 70L36 52M42 104L20 98M84 50L78 26'), motion('M202 70L220 52M214 104L236 98M172 50L178 26')],
    { cls: 'cr', tr: 'translate(160 224) rotate(-12)', shapes: mitten(C.yellow, { thumb: 1, len: 128, w: 70, cuff: C.blue }) },
    { cls: 'cl', tr: 'translate(96 224) rotate(12)', shapes: mitten(C.yellow, { thumb: -1, len: 128, w: 70, cuff: C.blue }) },
  ], [
    ['cl', '0%,100%{transform:rotate(0)}50%{transform:rotate(-8deg)}', 0.45, '96px 224px'],
    ['cr', '0%,100%{transform:rotate(0)}50%{transform:rotate(8deg)}', 0.45, '160px 224px'],
  ]),

  thinking: () => sticky([
    [face(), ink('M72 82Q88 76 104 82', 8), ink('M150 70Q168 58 186 72', 8), dotEyes(112, 34, 128, 11, 16, [4, -2]), ink('M122 170Q144 166 164 156', 8)],
    { tr: 'translate(80 246) rotate(-12)', shapes: [toon('path', { d: capsule(6, -46, 24, -94, 12) }, C.yellow, { c: [15, -70], k: 0.7, off: [-2, -2] }), toon('path', { d: rrect(-34, -58, 66, 50, 22) }, C.yellow, { c: [0, -33], k: 0.84, off: [-3, -3] }), ink('M-20 -40H8M-20 -24H8', 5)] },
  ]),

  facepalm: () => sticky([
    [face(), closedEyes(114, 34, 162, 14, 8).slice(1), ink('M118 170Q136 160 160 168', 8), ink('M156 84Q172 78 188 86', 8)],
    { tr: 'translate(82 222) rotate(28)', shapes: mitten(C.yellow, { thumb: 1, len: 140, w: 76, cuff: C.blue }) },
  ]),

  salute: () => sticky([
    [face(C.yellow, 120, 136, 92), ink('M60 98Q78 86 98 92', 8), dotEyes(118, 30, 120, 10, 15), smile(120, 162, 28, 16, 9), cheeks(150, 54, 120)],
    { tr: 'translate(232 136) rotate(-62)', shapes: mitten(C.yellow, { thumb: 0, len: 118, w: 54, cuff: C.blue }) },
  ]),

  shrug: () => sticky([
    [ball(128, 112, 82, C.yellow), ink('M78 76Q94 64 110 72', 8), ink('M146 72Q162 64 178 76', 8), dotEyes(100, 28, 128, 10, 14, [5, 0]), ink('M104 146Q124 146 152 134', 8)],
    { tr: 'translate(92 220) rotate(-45) scale(.46)', shapes: openHand(C.yellow) },
    { tr: 'translate(164 220) rotate(45) scale(.46) scale(-1 1)', shapes: openHand(C.yellow) },
  ]),

  wave: () => sticky([
    [motion('M48 92Q36 112 44 134'), motion('M30 76Q12 108 26 144'), motion('M210 70Q224 90 220 112')],
    { cls: 'w', tr: 'translate(140 234) rotate(-12) scale(.95)', shapes: openHand(C.yellow, { cuff: C.blue }) },
  ], [['w', '0%,100%{transform:rotate(0)}25%{transform:rotate(-14deg)}75%{transform:rotate(10deg)}', 1.1, '136px 232px']]),

  pray: () => sticky([
    [stroke('M128 22V34M88 34L96 46M168 34L160 46', C.yellow[0], 7, { edge: 4 }), sparkle(46, 96, 0.9), sparkle(212, 104, 0.7)],
    { tr: 'translate(154 226) rotate(-5)', shapes: mitten(C.yellow, { thumb: 0, len: 168, w: 56, cuff: C.blue }) },
    { tr: 'translate(102 226) rotate(5)', shapes: mitten(C.yellow, { thumb: 1, len: 168, w: 56, cuff: C.blue }) },
  ]),

  sleepy: () => sticky([
    [ball(118, 140, 90, C.yellow), closedEyes(132, 32, 118, 15, 8), fillInk('ellipse', { cx: 118, cy: 182, rx: 13, ry: 15 }, '#5b2338'), cheeks(156, 52, 118, 0.45)],
    { cls: 'z', shapes: [zzz(196, 72, 0.42), zzz(224, 34, 0.3)] },
  ], [['z', '0%,100%{transform:translate(0,0)}50%{transform:translate(4px,-9px)}', 2.4, '200px 60px']]),

  rage: () => sticky([{ cls: 'r', shapes: [
    face(C.red), ink('M64 84L108 104', 10), ink('M192 84L148 104', 10),
    fillInk('ellipse', { cx: 94, cy: 120, rx: 9, ry: 11 }), fillInk('ellipse', { cx: 162, cy: 120, rx: 9, ry: 11 }),
    flat('path', { d: rrect(84, 156, 88, 40, 14) }, '#fff', { w: 7, n: true }), ink('M84 176H172M106 158V194M128 158V194M150 158V194', 5),
  ] }], [['r', '0%,100%{transform:translate(0,0)}20%{transform:translate(-3px,1px)}40%{transform:translate(3px,-1px)}60%{transform:translate(-2px,-1px)}80%{transform:translate(2px,1px)}', 0.4, '128px 128px', 'linear']]),

  love: () => sticky([[
    face(), toon('path', { d: heartPath(92, 106, 1.25) }, C.red, { c: [92, 106], k: 0.78, off: [-2, -3], w: 6 }), toon('path', { d: heartPath(164, 106, 1.25) }, C.red, { c: [164, 106], k: 0.78, off: [-2, -3], w: 6 }),
    openMouth(128, 152, 40, 42, { teeth: false }), cheeks(154, 66),
  ]]),

  cool: () => sticky([[
    face(),
    flat('path', { d: 'M46 96H210L206 108H204C202 140 186 150 170 150C152 150 140 138 134 114H122C116 138 104 150 86 150C70 150 54 140 52 108H50Z' }, C.dark[1], { w: 6, n: true }),
    ink('M64 112L84 134M170 112L190 134', 7, { color: '#fff', x: { opacity: 0.45 } }),
    ink('M100 184Q134 192 164 170', 9),
  ]]),

  skull: () => sticky([[
    toon('path', { d: 'M128 28C76 28 40 64 40 112C40 140 54 160 76 170V200C76 214 86 224 100 224H156C170 224 180 214 180 200V170C202 160 216 140 216 112C216 64 180 28 128 28Z' }, C.white, { c: [128, 120], k: 0.88, off: [-4, -6] }),
    fillInk('path', { d: 'M76 116C76 98 90 92 102 92C116 92 120 104 118 116C116 132 104 142 92 142C82 142 76 132 76 116Z' }),
    fillInk('path', { d: 'M180 116C180 98 166 92 154 92C140 92 136 104 138 116C140 132 152 142 164 142C174 142 180 132 180 116Z' }),
    fillInk('path', { d: 'M128 150L138 170H118Z' }),
    ink('M106 190V222M128 190V224M150 190V222', 6),
  ]]),

  // ── Haven ──
  hello: () => sticky([
    [hexFeet(), hexArm(54, 150, 46, 168), hexBody(), mitt(46, 170)],
    { cls: 'w', shapes: [hexArm(196, 108, 214, 74), mitt(216, 66)] },
    [hexFace(128, 120, 'happy'), sparkle(220, 168, 0.8)],
  ], [['w', '0%,100%{transform:rotate(0)}25%{transform:rotate(16deg)}75%{transform:rotate(-12deg)}', 1, '196px 112px']]),

  welcome: () => sticky([
    [hexArm(64, 104, 40, 72), mitt(36, 66), hexArm(192, 104, 216, 72), mitt(220, 66)],
    [hexBody(128, 112, 74), hexFace(128, 108, 'grin', 74)],
    [toon('path', { d: 'M24 182L46 170V226L24 214Z' }, C.red, { c: [35, 198], k: 0.8 }), toon('path', { d: 'M232 182L210 170V226L232 214Z' }, C.red, { c: [221, 198], k: 0.8 }), plate(36, 172, 184, 50, C.red), lettering('WELCOME', 128, 197, 0.3, '#fff', { w: 18, edge: 4, gap: 8, shine: false })],
  ]),

  brb: () => sticky([
    [motion('M30 150H60M22 176H56M36 202H64')],
    { tr: 'rotate(10 150 160)', shapes: [hexFeet(150, 226, 26), hexArm(96, 168, 76, 186), hexBody(150, 162, 62), mitt(74, 188, 14), hexArm(200, 150, 214, 130), mitt(216, 126, 14), hexFace(150, 158, 'happy', 62)] },
    [lettering('BRB', 118, 50, 0.52, C.yellow[0], { w: 18, gap: 10 })],
  ]),

  afk: () => sticky([
    [hexFeet(118, 222, 28), hexBody(118, 156, 66), hexFace(118, 152, 'sleep', 66)],
    [lettering('AFK', 112, 48, 0.5, C.blue[0], { w: 18, gap: 10 })],
    { cls: 'z', shapes: [zzz(200, 116, 0.36, C.purple[0]), zzz(226, 82, 0.26, C.purple[0])] },
  ], [['z', '0%,100%{transform:translate(0,0)}50%{transform:translate(4px,-9px)}', 2.4, '210px 100px']]),

  gg: () => sticky([
    [hexArm(80, 160, 58, 132), mitt(54, 126, 14), hexArm(176, 160, 198, 132), mitt(202, 126, 14)],
    [hexFeet(128, 228, 24), hexBody(128, 176, 56), hexFace(128, 172, 'grin', 56)],
    [lettering('GG', 128, 62, 0.95, C.green[0], { w: 18, gap: 12 })],
  ]),

  ty: () => sticky([
    [hexFeet(128, 226, 26), hexBody(128, 168, 62), hexFace(128, 156, 'calm', 62)],
    [toon('path', { d: heartPath(128, 206, 1.3) }, C.red, { c: [128, 206], k: 0.8, w: 6 }), mitt(92, 204, 13), mitt(164, 204, 13)],
    [lettering('TY', 128, 56, 0.8, C.pink[0], { w: 18, gap: 8 })],
  ]),

  lol: () => sticky([
    [hexFeet(128, 228, 28), hexBody(128, 164, 66), hexFace(128, 158, 'grin', 66), tear(58, 142, 0.7), tear(198, 142, 0.7)],
    [lettering('LOL', 128, 50, 0.6, C.yellow[0], { w: 18, gap: 10 })],
  ]),

  ping: () => sticky([
    [hexFeet(100, 226, 26), hexBody(100, 164, 66), hexFace(100, 160, 'shock', 66), mitt(160, 182, 13), mitt(40, 182, 13)],
    { cls: 'pp', shapes: [toon('path', { d: 'M150 28H216C226 28 232 36 232 46V96C232 106 226 112 216 112H186L168 132L170 112H150C140 112 134 106 134 96V46C134 36 140 28 150 28Z' }, C.white, { c: [183, 70], k: 0.92, off: [-2, -3] }), lettering('@', 183, 70, 0.78, C.purple[0], { w: 14, edge: 4, shine: false })] },
  ], [['pp', '0%,60%,100%{transform:scale(1)}10%{transform:scale(1.12)}20%{transform:scale(.96)}30%{transform:scale(1.04)}', 1.6, '170px 128px']]),

  banhammer: () => sticky([
    [hexFeet(104, 226, 26), hexBody(104, 164, 66), hexFace(104, 160, 'stern', 66)],
    { cls: 'h', shapes: [toon('path', { d: capsule(156, 168, 190, 70, 9) }, C.brown, { c: [173, 119], k: 0.7, off: [-1, -2] }),
      toon('path', { d: 'M142 44L214 68Q224 72 220 82L208 116Q204 126 194 122L122 98Q112 94 116 84L128 50Q132 40 142 44Z' }, C.gray, { c: [168, 83], k: 0.86, off: [-3, -4] }),
      ink('M152 54L134 106M188 66L170 118', 6), mitt(158, 170, 14)] },
  ], [['h', '0%,55%,100%{transform:rotate(0)}20%{transform:rotate(-22deg)}35%{transform:rotate(6deg)}45%{transform:rotate(0)}', 1.4, '158px 172px']]),

  locked: () => sticky([
    [hexFeet(128, 226, 30), hexBody(128, 116, 82), hexFace(128, 90, 'calm', 82)],
    [stroke('M106 162V148C106 134 115 126 128 126C141 126 150 134 150 148V162', C.gray[0], 11, { edge: 6 }),
      toon('path', { d: rrect(88, 156, 80, 62, 14) }, C.yellow, { c: [128, 187], k: 0.86, off: [-3, -4] }),
      fillInk('path', { d: 'M128 172A9 9 0 0 1 133 188L136 204H120L123 188A9 9 0 0 1 128 172Z' }),
      mitt(84, 190, 14), mitt(172, 190, 14)],
  ]),

  // ── Gaming ──
  controller: () => sticky([[
    toon('path', { d: 'M78 74H178C210 74 230 100 234 140C238 182 226 206 204 206C186 206 176 190 166 176H90C80 190 70 206 52 206C30 206 18 182 22 140C26 100 46 74 78 74Z' }, C.purple, { c: [128, 140], k: 0.9, off: [-3, -5] }),
    flat('path', { d: 'M64 104H80V120H96V136H80V152H64V136H48V120H64Z' }, C.dark[1], { w: 4 }),
    flat('circle', { cx: 176, cy: 108, r: 10 }, C.yellow[0], { w: 5 }), flat('circle', { cx: 198, cy: 128, r: 10 }, C.red[0], { w: 5 }),
    flat('circle', { cx: 154, cy: 128, r: 10 }, C.blue[0], { w: 5 }), flat('circle', { cx: 176, cy: 148, r: 10 }, C.green[0], { w: 5 }),
    flat('path', { d: rrect(108, 120, 16, 8, 4) }, C.dark[0], { w: 4 }), flat('path', { d: rrect(132, 120, 16, 8, 4) }, C.dark[0], { w: 4 }),
  ]]),

  trophy: () => sticky([[
    stroke('M76 76C40 76 40 128 86 134M180 76C216 76 216 128 170 134', C.yellow[1], 12, { edge: 6 }),
    toon('path', { d: rrect(92, 186, 72, 40, 10) }, C.brown, { c: [128, 206], k: 0.86 }),
    toon('path', { d: 'M114 150H142L148 188H108Z' }, C.yellow, { c: [128, 170], k: 0.8 }),
    toon('path', { d: 'M70 40H186V96C186 132 162 158 128 158C94 158 70 132 70 96Z' }, C.yellow, { c: [128, 98], k: 0.86, off: [-4, -5] }),
    toon('path', { d: starPath(128, 94, 26, 11) }, ['#fff7d1', '#ffe58a'], { c: [128, 94], k: 0.8, w: 5 }),
    flat('path', { d: rrect(100, 198, 56, 14, 4) }, C.yellow[0], { w: 4 }),
  ]]),

  crown: () => sticky([[
    toon('path', { d: 'M40 196L30 86L84 132L128 62L172 132L226 86L216 196Z' }, C.yellow, { c: [128, 140], k: 0.88, off: [-3, -4] }),
    toon('path', { d: rrect(38, 176, 180, 40, 12) }, C.yellow, { c: [128, 196], k: 0.9 }),
    [[30, 82], [128, 56], [226, 82]].map(([x, y]) => ball(x, y, 13, C.yellow, { inset: 4, w: 6 })),
    toon('path', { d: 'M128 178L142 196L128 214L114 196Z' }, C.red, { c: [128, 196], k: 0.7, w: 5 }),
    ball(80, 196, 9, C.blue, { inset: 3, w: 5 }), ball(176, 196, 9, C.green, { inset: 3, w: 5 }),
  ]]),

  'level-up': () => sticky([
    [toon('path', { d: 'M128 26L210 112H164V150H92V112H46Z' }, C.green, { c: [128, 96], k: 0.86, off: [-3, -4] }), shine(108, 72, 12, 6, -45, 0.5)],
    [lettering('UP', 128, 196, 0.72, C.yellow[0], { w: 18, gap: 10 })],
  ]),

  star: () => sticky([{ cls: 's', shapes: [
    toon('path', { d: starPath(128, 136, 106, 50) }, C.yellow, { c: [128, 136], k: 0.86, off: [-3, -5], w: 8 }),
    dotEyes(138, 20, 128, 7, 11), smile(128, 162, 14, 9, 7), cheeks(156, 34, 128, 0.5),
  ] }, { cls: 't1', shapes: [sparkle(222, 54, 0.9)] }, { cls: 't2', shapes: [sparkle(36, 206, 0.7)] }],
  [['s', '0%,100%{transform:rotate(0) scale(1)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg) scale(1.05)}', 1.6, '128px 140px'], ['t1', '0%,100%{transform:scale(1)}50%{transform:scale(.5)}', 0.8, '222px 54px'], ['t2', '0%,100%{transform:scale(1)}50%{transform:scale(.5)}', 1.6, '36px 206px']]),

  gem: () => sticky([[
    toon('path', { d: 'M76 44H180L228 100L128 222L28 100Z' }, C.blue, { c: [128, 120], k: 0.88, off: [-3, -5] }),
    ink('M28 100H228M76 44L100 100L128 44L156 100L180 44M100 100L128 222L156 100', 5),
    shape('path', { d: 'M86 52L100 92L118 52Z' }, { f: '#fff', n: true, x: { opacity: 0.55 } }),
  ]]),

  potion: () => sticky([[
    toon('path', { d: rrect(104, 26, 48, 30, 8) }, C.brown, { c: [128, 41], k: 0.8 }),
    toon('path', { d: 'M108 52H148V96C184 108 206 136 206 168C206 206 172 230 128 230C84 230 50 206 50 168C50 136 72 108 108 96Z' }, ['#efeafc', '#cbc2e6'], { c: [128, 150], k: 0.9, off: [-3, -4] }),
    shape('path', { d: 'M60 158C88 146 108 170 128 160C150 150 170 144 196 158C200 196 170 220 128 220C86 220 58 198 60 158Z' }, { f: C.pink[1], n: true }),
    shape('path', { d: 'M66 160C92 150 110 172 128 164C150 154 170 150 190 160C190 170 186 180 180 186C150 200 100 196 66 176Z' }, { f: C.pink[0], n: true }),
    shape('path', { d: 'M108 52H148V96C184 108 206 136 206 168C206 206 172 230 128 230C84 230 50 206 50 168C50 136 72 108 108 96Z' }, { f: 'none', s: INK, w: 7, n: true }),
    ink('M108 60H148', 7), shine(84, 128, 14, 7, -50, 0.75), flat('circle', { cx: 104, cy: 190, r: 7 }, '#fff', { w: 4 }), flat('circle', { cx: 142, cy: 178, r: 5 }, '#fff', { w: 4 }),
  ]]),

  rip: () => sticky([[
    toon('path', { d: 'M56 216V102C56 58 88 30 128 30C168 30 200 58 200 102V216Z' }, C.gray, { c: [128, 120], k: 0.88, off: [-3, -5] }),
    lettering('RIP', 128, 110, 0.48, C.dark[0], { w: 16, edge: 0, gap: 10, shine: false }),
    ink('M88 160H168M96 182H160', 6, { color: C.gray[1] }),
    toon('path', { d: 'M28 226C34 206 44 202 52 214C58 196 70 196 76 212C84 200 92 204 96 214H160C164 204 172 200 180 212C186 196 198 196 204 214C212 202 222 206 228 226Z' }, C.green, { c: [128, 214], k: 0.86 }),
  ]]),

  rocket: () => sticky([{ cls: 'k', tr: 'rotate(40 128 128)', shapes: [
    toon('path', { d: 'M100 190L128 236L156 190Z' }, C.orange, { c: [128, 206], k: 0.7, off: [0, -6] }),
    toon('path', { d: 'M92 140L60 182V204L96 186Z' }, C.red, { c: [80, 176], k: 0.8 }), toon('path', { d: 'M164 140L196 182V204L160 186Z' }, C.red, { c: [176, 176], k: 0.8 }),
    toon('path', { d: 'M128 20C160 44 172 92 168 150L160 192H96L88 150C84 92 96 44 128 20Z' }, C.white, { c: [128, 110], k: 0.88, off: [-4, -4] }),
    toon('path', { d: 'M128 20C146 34 156 52 162 70H94C100 52 110 34 128 20Z' }, C.red, { c: [128, 50], k: 0.8 }),
    ball(128, 110, 22, C.blue, { inset: 6 }), shine(120, 102, 7, 4, -40, 0.8),
    flat('path', { d: 'M114 192V208M128 192V212M142 192V208' }, 'none', { w: 6 }),
  ] }], [['k', '0%,100%{transform:translate(0,0)}25%{transform:translate(2px,-2px)}50%{transform:translate(-1px,2px)}75%{transform:translate(2px,1px)}', 0.3, '128px 128px', 'linear']]),

  coffee: () => sticky([
    [stroke('M96 58C88 46 104 40 96 26M128 58C120 46 136 40 128 26M160 58C152 46 168 40 160 26', C.white[1], 8, { edge: 4 })],
    [stroke('M188 110C226 106 228 170 184 168', C.white[0], 14, { edge: 6 }),
      toon('path', { d: 'M52 82H196V178C196 206 176 224 150 224H98C72 224 52 206 52 178Z' }, C.white, { c: [124, 150], k: 0.88, off: [-3, -4] }),
      flat('ellipse', { cx: 124, cy: 84, rx: 72, ry: 14 }, C.brown[1], { w: 6 }),
      dotEyes(150, 26, 124, 8, 11), smile(124, 172, 14, 9, 7), cheeks(166, 42, 124, 0.5)],
  ]),

  pizza: () => sticky([[
    toon('path', { d: 'M38 66C96 40 160 40 218 66L128 230Z' }, C.yellow, { c: [128, 120], k: 0.88, off: [0, -2] }),
    stroke('M40 62C96 36 160 36 216 62', C.brown[0], 22, { edge: 6 }),
    [[104, 98, 15], [154, 92, 14], [128, 146, 14], [112, 186, 10], [158, 130, 9]].map(([x, y, r]) => ball(x, y, r, C.red, { inset: 4, w: 5 })),
    flat('path', { d: 'M78 112C78 130 70 138 74 146C80 154 88 146 86 130Z' }, C.yellow[0], { w: 5 }),
  ]]),

  loot: () => sticky([[
    [sparkle(40, 50, 0.8), sparkle(216, 44, 1), sparkle(128, 22, 0.7)],
    toon('path', { d: 'M40 120H216V208C216 218 210 224 200 224H56C46 224 40 218 40 208Z' }, C.brown, { c: [128, 172], k: 0.9, off: [-3, -4] }),
    toon('path', { d: 'M40 120C40 82 64 62 128 62C192 62 216 82 216 120Z' }, C.brown, { c: [128, 96], k: 0.88, off: [-3, -4] }),
    flat('path', { d: rrect(36, 112, 184, 18, 6) }, C.yellow[1], { w: 6 }),
    flat('path', { d: 'M72 66V120M184 66V120M72 130V224M184 130V224' }, 'none', { s: C.yellow[1], w: 12, n: true }),
    toon('path', { d: rrect(110, 118, 36, 40, 8) }, C.yellow, { c: [128, 138], k: 0.8, w: 6 }), fillInk('circle', { cx: 128, cy: 136, r: 6 }), ink('M128 138V148', 5),
  ]]),
};

// Packs, in picker order. `icon` names the sticker shown on the pack's tab.
const packs = [
  { id: 'reactions', name: 'Reactions', icon: 'heart', stickers: [
    ['thumbs-up', 'like yes approve good agree +1'], ['thumbs-down', 'dislike no disagree bad -1'], ['heart', 'love like favorite'],
    ['fire', 'lit hot flame awesome'], ['100', 'hundred perfect keep it real'], ['check', 'done yes correct tick ok'],
    ['nope', 'no cross wrong x cancel'], ['ok', 'okay fine alright got it'], ['eyes', 'look see watching sus'],
    ['laugh', 'lol haha joy funny lmao'], ['cry', 'sad tears sob upset'], ['mind-blown', 'wow shocked omg boom explode'],
    ['party', 'celebrate tada hooray congrats'], ['clap', 'applause bravo well done'], ['thinking', 'hmm think wonder ponder'],
    ['facepalm', 'ugh doh embarrassed smh'], ['salute', 'respect yes sir o7 aye'], ['shrug', 'dunno whatever idk meh'],
    ['wave', 'hi hello bye wave'], ['pray', 'please thanks hope fingers crossed'], ['sleepy', 'tired sleep zzz bored'],
    ['rage', 'angry mad furious grr'], ['love', 'heart eyes crush adore'], ['cool', 'sunglasses chill nice'],
    ['skull', 'dead dying lmao rip'],
  ] },
  { id: 'haven', name: 'Haven', icon: 'hello', stickers: [
    ['hello', 'hi hey wave mascot hex'], ['welcome', 'welcome join hi mascot hex'], ['brb', 'be right back away mascot'],
    ['afk', 'away sleep idle mascot'], ['gg', 'good game win well played mascot'], ['ty', 'thanks thank you heart mascot'],
    ['lol', 'laugh haha funny mascot'], ['ping', 'mention notify at alert mascot'], ['banhammer', 'ban mod hammer moderator kick'],
    ['locked', 'encrypted e2e private secure lock'],
  ] },
  { id: 'gaming', name: 'Gaming', icon: 'controller', stickers: [
    ['controller', 'game play gamepad gaming'], ['trophy', 'win winner champion cup'], ['crown', 'king queen best royal'],
    ['level-up', 'lvl up upgrade progress arrow'], ['star', 'favorite shine gold great'], ['gem', 'diamond rare loot shiny'],
    ['potion', 'heal hp mana flask'], ['rip', 'dead tombstone grave gg'], ['rocket', 'launch fast ship it moon'],
    ['coffee', 'caffeine mug morning brew'], ['pizza', 'food snack slice'], ['loot', 'chest treasure reward gold'],
  ] },
];

// Starter-pack names from earlier Haven versions that these stickers replace.
const LEGACY = { 'thumbs-up': 'thumbs-up', heart: 'heart', fire: 'fire', check: 'check', nope: 'nope', eyes: 'eyes', laugh: 'laugh', party: 'party' };

module.exports = { art, packs, LEGACY };

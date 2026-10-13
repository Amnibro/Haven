'use strict';

// Builds Haven's built-in sticker packs into public/stickers/.
//
//   node tools/stickers/build.js
//
// Needs Chrome or Chromium and the puppeteer-core package (not a Haven
// dependency: `npm i --no-save puppeteer-core`, or point PUPPETEER_CORE at an
// install), plus Python 3 with Pillow for the PNG step. CHROME overrides the
// browser path.
//
// For every sticker in art.js it:
//   1. renders the drawing, measures what it covers (every animation frame
//      included) and scales/centres it into the same safe box, so all stickers
//      share one margin and nothing touches the edge;
//   2. writes <pack>/<id>.svg, the file servers copy and browsers show;
//   3. writes <pack>/<id>.png for apps that cannot draw SVG (Haven for iOS):
//      the resting frame. STICKER_APNG=1 makes moving stickers animated PNGs
//      instead, at roughly 40-170 KB each rather than ~10 KB;
//   4. writes packs.json, which the server reads to seed and upgrade packs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { art, packs, LEGACY } = require('./art');

const OUT = path.join(__dirname, '..', '..', 'public', 'stickers');
const SAFE = 236;        // the fitted drawing spans at most this many units of 256
const MAX_SCALE = 1.1;
const PNG_SIZE = 320;    // 128pt on a 2.5x screen; iOS shows stickers at 128pt at most
const APNG_SIZE = 256;
const FPS = 12;

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const found = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME to its path');
  return found;
}

const durations = (svg) => [...svg.matchAll(/animation:\S+ ([\d.]+)s/g)].map((m) => parseFloat(m[1]));

async function main() {
  const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage();
  // The sticker sits PAD px in from the corner with overflow showing, so a
  // drawing that pokes past its viewBox is still measured in full.
  const PAD = 64;
  await page.setContent(`<html><head><style>svg{overflow:visible;display:block}</style></head><body style="margin:0;background:transparent"><div id="s" style="position:absolute;left:${PAD}px;top:${PAD}px;width:256px;height:256px"></div></body></html>`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-stickers-'));

  // Render the sticker at time t (seconds), or at rest when t is null.
  async function shot(svg, t, size, whole = false) {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: t === null ? 'reduce' : 'no-preference' }]);
    await page.setViewport({ width: 256 + PAD * 2, height: 256 + PAD * 2, deviceScaleFactor: size / 256 });
    await page.evaluate((markup, time) => {
      const box = document.getElementById('s');
      if (box.dataset.markup !== markup) { box.innerHTML = markup; box.dataset.markup = markup; }
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = (time || 0) * 1000; }
    }, svg, t);
    const clip = whole ? { x: 0, y: 0, width: 256 + PAD * 2, height: 256 + PAD * 2 } : { x: PAD, y: PAD, width: 256, height: 256 };
    return page.screenshot({ clip, omitBackground: true });
  }
  async function bbox(png) {
    return page.evaluate(async (b64) => {
      const im = new Image();
      im.src = 'data:image/png;base64,' + b64;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const x = c.getContext('2d');
      x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let X = 0; X < c.width; X++) {
        if (d[(y * c.width + X) * 4 + 3] > 6) { if (X < x0) x0 = X; if (X > x1) x1 = X; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return [x0, y0, x1 + 1, y1 + 1];
    }, Buffer.from(png).toString('base64')).then((b) => b.map((n) => n - PAD));
  }
  const frameTimes = (svg) => {
    const ds = durations(svg);
    if (!ds.length) return [];
    const loop = Math.max(...ds);
    const n = Math.max(8, Math.round(loop * FPS));
    return Array.from({ length: n }, (_, i) => (loop * i) / n);
  };

  const manifest = { version: 1, packs: [] };
  const report = [];
  for (const pack of packs) {
    fs.mkdirSync(path.join(OUT, pack.id), { recursive: true });
    const entry = { id: pack.id, name: pack.name, icon: pack.icon, stickers: [] };
    for (const [id, keywords] of pack.stickers) {
      const render = art[id]();
      const raw = render();
      const times = frameTimes(raw);
      // Union of the resting frame and every animation frame.
      let box = await bbox(await shot(raw, null, 256, true));
      for (const t of times) {
        const b = await bbox(await shot(raw, t, 256, true));
        box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
      }
      const s = Math.min(MAX_SCALE, SAFE / (box[2] - box[0]), SAFE / (box[3] - box[1]));
      const cx = (box[0] + box[2]) / 2;
      const cy = (box[1] + box[3]) / 2;
      const r = (n) => Math.round(n * 100) / 100;
      const svg = render({ fit: `translate(${r(128 - s * cx)} ${r(128 - s * cy)}) scale(${r(s)})` });
      const svgFile = path.join(OUT, pack.id, `${id}.svg`);
      fs.writeFileSync(svgFile, svg);

      // Raster fallback: resting frame, or every frame of the loop.
      const dir = fs.mkdtempSync(path.join(tmp, id + '-'));
      fs.writeFileSync(path.join(dir, 'rest.png'), await shot(svg, null, PNG_SIZE));
      const ft = process.env.STICKER_APNG === '1' ? frameTimes(svg) : [];
      for (let i = 0; i < ft.length; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.png`), await shot(svg, ft[i], APNG_SIZE));
      const pngFile = path.join(OUT, pack.id, `${id}.png`);
      const frameMs = ft.length ? Math.round((Math.max(...durations(svg)) * 1000) / ft.length) : 0;
      execFileSync('python3', [path.join(__dirname, 'encode_png.py'), dir, pngFile, String(frameMs)], { stdio: 'inherit' });

      const legacy = Object.entries(LEGACY).filter(([, to]) => to === id).map(([from]) => from);
      entry.stickers.push({ id, name: id, keywords: keywords.split(' '), animated: times.length > 0, ...(legacy.length ? { legacy } : {}),
        sha256: crypto.createHash('sha256').update(svg).digest('hex') });
      report.push([`${pack.id}/${id}`, fs.statSync(svgFile).size, fs.statSync(pngFile).size, ft.length]);
    }
    manifest.packs.push(entry);
  }
  fs.writeFileSync(path.join(OUT, 'packs.json'), JSON.stringify(manifest, null, 1) + '\n');
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  let svgTotal = 0;
  let pngTotal = 0;
  for (const [name, a, b, frames] of report) {
    svgTotal += a; pngTotal += b;
    console.log(`${name.padEnd(24)} svg ${String(a).padStart(6)}  png ${String(b).padStart(7)}${frames ? `  ${frames} frames` : ''}`);
  }
  console.log(`${report.length} stickers: svg ${(svgTotal / 1024).toFixed(1)} KB, png ${(pngTotal / 1024).toFixed(1)} KB`);
}

main().catch((err) => { console.error(err); process.exit(1); });

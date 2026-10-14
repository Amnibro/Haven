#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..'), pub = path.join(root, 'public'), base = process.argv[2] || 'origin/main';
const changed = new Set(execFileSync('git', ['-C', root, 'diff', '--name-only', base, '--', 'public'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => path.join(root, f)));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'vendor' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const sources = walk(pub).filter((f) => /\.(js|css|html)$/.test(f) && f !== path.join(pub, 'app.html'));
const ref = /(['"(])((?:\.{1,2}\/|\/)[\w./-]+\.(?:js|css|woff2?|svg|png))\?v=([^'"()\s]*)/g;
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 8);
const edited = new Set(), upstream = (f) => { try { return execFileSync('git', ['-C', root, 'show', `${base}:${path.relative(root, f)}`]); } catch { return null; } };
const differs = (f) => changed.has(f) || (edited.has(f) && !fs.readFileSync(f).equals(upstream(f) || Buffer.alloc(0)));
for (let pass = 0, dirty = true; dirty && pass < 6; pass++) {
  dirty = false;
  for (const src of sources) {
    const text = fs.readFileSync(src, 'utf8');
    const out = text.replace(ref, (m, q, p, v) => {
      const target = p.startsWith('/') ? path.join(pub, p) : path.resolve(path.dirname(src), p), plain = v.replace(/-a[0-9a-f]{8}$/, '');
      return `${q}${p}?v=${fs.existsSync(target) && differs(target) ? `${plain}-a${sha(target)}` : plain}`;
    });
    out !== text && (fs.writeFileSync(src, out), edited.add(src), dirty = true);
  }
}
console.log([...edited].map((f) => path.relative(root, f)).join('\n') || 'no cache busters changed');

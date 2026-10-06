'use strict';

// Where each product's releases come from. A product can have a GitHub repo
// (releases), a local changelog, or both; the same version from both sources
// is only posted once. Changelog entries count as releases only when the
// heading carries a version number, so dated dev-log entries stay quiet.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const AI = process.env.AMNI_AI_ROOT || path.join(os.homedir(), 'ai');
const SITE = 'https://amni-scient.com';

const SOURCES = {
  Braid:          { changelog: 'braid-desktop/changelog.md', page: `${SITE}/braid` },
  Symphony:       { github: 'Amnibro/Symphony', changelog: 'Symphony/CHANGELOG.md', page: `${SITE}/symphony.html` },
  'Grok-Remote':  { github: 'Amnibro/grok-remote', page: `${SITE}/grok-remote.html` },
  'Amni-OS':      { changelog: 'amni-os/changelog.md', page: `${SITE}/amni-os.html` },
  'Amni-AI':      { changelog: 'Amni-Ai/changelog.md', page: `${SITE}/amni-ai.html` },
  'Amni-Browse':  { github: 'Amnibro/Amni-Browse', changelog: 'Amni-Browse/CHANGELOG.md', page: `${SITE}/amni-browse.html` },
  'Amni-Calc':    { changelog: 'Amni-Calc/CHANGELOG.md', page: `${SITE}/amni-calc.html` },
  'Amni-Explore': { changelog: 'Amni-Explore/CHANGELOG.md', page: `${SITE}/amni-explore.html` },
  'Amni-Space':   { github: 'Amnibro/Amni-Scient', tagPrefix: 'amni-space-', changelog: 'Amni-Space/changelog.md', page: `${SITE}/amni-space.html` },
  'Amni-Weather': { page: `${SITE}/amni-weather.html` },
  'Amni-Game':    { changelog: 'Amni-Game-v2/docs/changelog.md', page: `${SITE}/game/v2/` },
  'Amni-Learn':   { changelog: 'Amni-Learn/CHANGELOG.md', page: `${SITE}/amni-learn.html` },
  'Amni-LLM':     { changelog: 'Amni-LLM/changelog.md', page: `${SITE}/amni-llm.html` },
  'Amni-Connect': { github: 'Amnibro/Amni-Connect', changelog: 'Amni-Connect/CHANGELOG.md', page: `${SITE}/amni-connect.html` },
  'Amni-Code':    { changelog: 'Amni-Code/changelog.md', page: `${SITE}/amni-code.html` },
  'Amni-Core':    { github: 'Amnibro/Amni-Core', page: `${SITE}/amni-core.html` },
  'Amni-Haven':   { changelog: 'Amni-Haven/CHANGELOG.md', page: `${SITE}/amni-haven.html` },
  HedgeDoc:       { github: 'Amnibro/hedgedoc-android', changelog: 'hedgedoc-android/changelog.md', page: `${SITE}/amni-hedgedoc.html` },
  'Amni-Crypt':   { changelog: 'Amni-crypt/CHANGELOG.md', page: `${SITE}/amni-crypt.html` },
  'Amni-Life':    { changelog: 'Amni-Life/CHANGELOG.md', page: `${SITE}/amni-life.html` },
  'Amni-Prayer':  { page: `${SITE}/amni-prayer.html` },
  'Amni-Type':    { changelog: 'amni-type/changelog.md', page: `${SITE}/amni-type.html` },
  'Amni-Mail':    { changelog: 'Amni-Mail/CHANGELOG.md', page: `${SITE}/amni-mail.html` }
};

const VERSION_RE = /\[?\bv?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\]?/;
const DATE_RE = /\b(20\d\d-\d\d-\d\d)\b/;

function normVersion(v) {
  return String(v || '').replace(/^v/i, '').trim().toLowerCase();
}

function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

function clean(s) {
  return s.replace(/\s+/g, ' ').replace(/^[-*]\s+/, '').trim();
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Split a changelog into entries at its first heading level below the title.
function parseChangelog(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const heads = lines.map((l, i) => ({ i, m: /^(#{2,3})\s+(.*)$/.exec(l) })).filter((h) => h.m);
  if (!heads.length) return [];
  const level = Math.min(...heads.map((h) => h.m[1].length));
  const tops = heads.filter((h) => h.m[1].length === level);
  const out = [];
  tops.forEach((h, k) => {
    const end = k + 1 < tops.length ? tops[k + 1].i : lines.length;
    const body = lines.slice(h.i + 1, end);
    const heading = h.m[2].trim();
    const vm = VERSION_RE.exec(heading.replace(DATE_RE, ''));
    if (!vm) return;
    const date = (DATE_RE.exec(heading) || [])[1] || '';
    let title = heading
      .replace(vm[0], '')
      .replace(DATE_RE, '')
      .replace(/\(\s*\)|\(\d+\)/g, '')
      .replace(/^[\s\-—–:·|]+|[\s\-—–:·|]+$/g, '')
      .replace(/\s*[—–-]\s*[—–-]\s*/g, ' — ')
      .trim();
    const bullets = [];
    let section = '';
    let fence = false;
    let last = null;
    for (const raw of body) {
      if (/^\s*```/.test(raw)) { fence = !fence; last = null; continue; }
      if (fence) continue;
      const sub = /^#{3,6}\s+(.*)$/.exec(raw);
      if (sub) {
        const s = clean(sub[1]);
        if (!title) { title = s; continue; }
        section = s.length <= 24 ? s : '';
        last = null;
        continue;
      }
      const b = /^[-*]\s+(.*)$/.exec(raw);
      const para = /^\*\*([^*]{1,40}?)[.:]?\*\*[.:]?\s+(.*)$/.exec(raw);
      if (b || para) {
        const t = b ? clean(b[1]).replace(/\*\*/g, '') : `**${para[1]}:** ${clean(para[2])}`;
        if (!t) { last = null; continue; }
        bullets.push(section && b ? `**${section}:** ${t}` : t);
        last = bullets.length - 1;
        continue;
      }
      if (last !== null && /^\s+\S/.test(raw) && !/^\s+[-*]\s/.test(raw)) {
        bullets[last] += ' ' + clean(raw).replace(/\*\*/g, '');
        continue;
      }
      if (!raw.trim() || /^\s+[-*]\s/.test(raw)) last = null;
    }
    if (!title) {
      const para = body.find((l) => /^\S/.test(l) && !/^[#>|`*-]/.test(l) && l.trim().length <= 140);
      if (para) title = clean(para);
    }
    out.push({ version: vm[1], key: normVersion(vm[1]), date, title: clip(title, 140), bullets });
  });
  return out;
}

function changelogEntries(product) {
  const src = SOURCES[product];
  if (!src || !src.changelog) return [];
  const file = path.join(AI, src.changelog);
  if (!fs.existsSync(file)) return [];
  return parseChangelog(fs.readFileSync(file, 'utf8')).map((e) => ({ ...e, source: 'changelog' }));
}

function githubReleases(product) {
  const src = SOURCES[product];
  if (!src || !src.github) return [];
  let raw;
  try {
    raw = execFileSync('gh', ['api', `repos/${src.github}/releases?per_page=10`], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  let list = [];
  try { list = JSON.parse(raw); } catch { return []; }
  return list
    .filter((r) => !r.draft && (!src.tagPrefix || String(r.tag_name).startsWith(src.tagPrefix)))
    .map((r) => {
      const tag = src.tagPrefix ? r.tag_name.slice(src.tagPrefix.length) : r.tag_name;
      const vm = VERSION_RE.exec(tag) || VERSION_RE.exec(r.name || '');
      if (!vm) return null;
      const bodyEntry = parseChangelog(`## v${vm[1]}\n${r.body || ''}`)[0] || { bullets: [] };
      let title = (r.name || '').replace(vm[0], '').replace(/^[\s\-—–:·|]+|[\s\-—–:·|]+$/g, '').trim();
      if (!title || title.toLowerCase() === product.toLowerCase()) title = bodyEntry.title || '';
      return {
        version: vm[1], key: normVersion(vm[1]), date: (r.published_at || '').slice(0, 10),
        title: clip(title, 140), bullets: bodyEntry.bullets, url: r.html_url, prerelease: !!r.prerelease, source: 'github'
      };
    })
    .filter(Boolean);
}

// All known releases for a product, newest first, one per version. A GitHub
// release wins over the changelog entry for the same version (it has a URL),
// but borrows the changelog's notes when its own body is empty.
function releasesFor(product) {
  const byKey = new Map();
  for (const e of changelogEntries(product)) if (!byKey.has(e.key)) byKey.set(e.key, e);
  for (const r of githubReleases(product)) {
    const prev = byKey.get(r.key);
    byKey.set(r.key, prev ? { ...prev, ...r, title: r.title || prev.title, bullets: r.bullets.length ? r.bullets : prev.bullets, date: r.date || prev.date } : r);
  }
  return [...byKey.values()].sort((a, b) => (a.date && b.date && a.date !== b.date ? b.date.localeCompare(a.date) : cmpVersion(b.key, a.key)));
}

function firstSentences(s, n) {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return cut > 40 ? head.slice(0, cut + 1) : s;
}

function formatRelease(product, rel, { maxBullets = 6 } = {}) {
  const src = SOURCES[product] || {};
  const head = `## 🚀 ${product} v${normVersion(rel.version)}${rel.prerelease ? ' (prerelease)' : ''}`;
  const sub = [rel.title && `*${rel.title}*`, rel.date].filter(Boolean).join(' · ');
  const bullets = rel.bullets.slice(0, maxBullets).map((b) => `- ${clip(firstSentences(b, 220), 220)}`);
  const more = rel.bullets.length > maxBullets ? `- …and ${rel.bullets.length - maxBullets} more` : '';
  const links = [rel.url && `[Release notes](${rel.url})`, src.page && `[Product page](${src.page})`].filter(Boolean).join(' · ');
  return [head, sub, '', ...bullets, more, '', links].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n').trim();
}

module.exports = { SOURCES, releasesFor, formatRelease, normVersion, parseChangelog };

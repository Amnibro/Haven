// Pictures sent together (#5799). They used to go out as one message per
// picture, which pushed everything else out of view. Now a batch from the
// message box, a thread or the DM pop-out goes out as one message: the text on
// top, then one line per upload, the form forum topics already use. In the
// feed, two or more pictures (and videos) in a row show as one grid, laid out
// by count; clicking a tile opens the lightbox on that message's pictures.
//
// The layout and line helpers are pure, so the tests can drive them.

// Tiles per row for each count, on a six-column grid. Three is the one
// layout that is not rows: a large picture on the left, two stacked beside it.
const GRID_ROWS = { 2: [2], 4: [2, 2], 5: [2, 3], 6: [3, 3], 7: [1, 3, 3], 8: [2, 3, 3], 9: [3, 3, 3] };
// The grid's width to height, fixed before anything loads so the feed keeps
// its place while the tiles fill in.
const GRID_RATIO = { 2: '2 / 1', 3: '4 / 3', 4: '4 / 3', 5: '6 / 5', 6: '3 / 2', 7: '1 / 1', 8: '1 / 1', 9: '1 / 1' };
const GRID_SHOWN = 9;

const PICTURE_LINE = /^(?:spoiler-img:)?\/uploads\/(?:[\w\-]+\/)?[\w\-.]+\.(?:jpg|jpeg|png|gif|webp|svg)$/i;
const E2E_PICTURE_LINE = /^(?:spoiler-img:)?e2e-img:image\/(?:jpeg|png|gif|webp|svg\+xml):\/uploads\/[\w\-.]+$/i;
const VIDEO_LINE = /^\[file:[^\]\n]+\]\((\/uploads\/[^\s|)]+\.(?:mp4|webm|mov|m4v))\|[^)\n]+\)$/i;

export default {

// ── Pure helpers ──────────────────────────────────────────

// How a grid of `count` tiles is laid out: the tiles shown (at most nine),
// how many more sit behind the "+N" on the last one, the row count, each
// shown tile's [columns, rows] span on the six-column grid, and the grid's
// aspect ratio. Null below two, which shows as a single picture as before.
_mediaGridLayout(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 2) return null;
  const shown = Math.min(n, GRID_SHOWN);
  const more = n > GRID_SHOWN ? n - (GRID_SHOWN - 1) : 0;
  if (shown === 3) return { shown, more, rows: 2, spans: [[3, 2], [3, 1], [3, 1]], ratio: GRID_RATIO[3] };
  const perRow = GRID_ROWS[shown];
  const spans = perRow.flatMap(k => Array.from({ length: k }, () => [6 / k, 1]));
  return { shown, more, rows: perRow.length, spans, ratio: GRID_RATIO[shown] };
},

// What a content line shows as in a grid: 'image', 'video', or null for
// anything else (text, other files, a link).
_mediaGridKind(line) {
  const l = String(line || '').trim();
  if (PICTURE_LINE.test(l) || E2E_PICTURE_LINE.test(l)) return 'image';
  if (VIDEO_LINE.test(l)) return 'video';
  return null;
},

// The run of grid lines starting at lines[from]: consecutive pictures and
// videos, trimmed.
_mediaGridRun(lines, from) {
  const run = [];
  for (let i = from; i < lines.length; i++) {
    const l = String(lines[i] || '').trim();
    if (!this._mediaGridKind(l)) break;
    run.push(l);
  }
  return run;
},

// ── Feed ──────────────────────────────────────────────────

// Video tiles open the video viewer; picture tiles are chat images and go
// through the usual lightbox click.
_setupMediaGrid() {
  document.addEventListener('click', (e) => {
    const tile = e.target.closest && e.target.closest('.media-grid-tile.is-video');
    if (!tile) return;
    e.preventDefault();
    e.stopPropagation();
    const src = tile.dataset.videoSrc;
    if (src) this._openVideoLightbox?.(src);
  });
},

// The grid for a run of picture and video lines.
_mediaGridHtml(lines) {
  const layout = this._mediaGridLayout(lines.length);
  if (!layout) return lines.map(l => `<div class="content-media-part">${this._formatContent(l)}</div>`).join('');
  const tiles = lines.map((line, i) => {
    const hidden = i >= layout.shown;
    const [cs, rs] = hidden ? [1, 1] : layout.spans[i];
    const video = this._mediaGridKind(line) === 'video' ? VIDEO_LINE.exec(line) : null;
    const inner = video
      ? `<video class="media-grid-video" src="${this._escapeHtml(video[1])}" preload="metadata" muted playsinline></video><span class="media-grid-play" aria-hidden="true">▶</span>`
      : this._formatContent(line);
    const more = layout.more && i === layout.shown - 1
      ? `<span class="media-grid-more" title="${this._escapeHtml(t('media_grid.more', { count: layout.more }))}">+${layout.more}</span>`
      : '';
    const cls = 'media-grid-tile' + (video ? ' is-video' : '') + (hidden ? ' mg-hidden' : '');
    const attrs = video ? ` data-video-src="${this._escapeHtml(video[1])}" role="button" tabindex="0" title="${this._escapeHtml(t('media_grid.play_video'))}"` : '';
    return `<div class="${cls}" style="grid-column:span ${cs};grid-row:span ${rs}"${attrs}>${inner}${more}</div>`;
  }).join('');
  const label = this._escapeHtml(t('media_grid.label', { count: lines.length }));
  return `<div class="media-grid" data-count="${lines.length}" role="group" aria-label="${label}" style="aspect-ratio:${layout.ratio};grid-template-rows:repeat(${layout.rows},minmax(0,1fr))">${tiles}</div>`;
},

};

'use strict';

// The sticker picker's pack tabs, search and recents (app-emoji-stickers.js),
// and resting a moving sticker for viewers who asked for less motion
// (app-appearance.js).

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const load = async (file) => Object.assign({}, (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'modules', file)).href)).default);
let M;
let A;
test.before(async () => {
  M = await load('app-emoji-stickers.js');
  A = await load('app-appearance.js');
});

const S = (name, pack, keywords = [], extra = {}) => ({ name, pack_name: pack, keywords, url: `/uploads/stickers/${name}.svg`, ...extra });
const STICKERS = [
  S('heart', 'Reactions', ['love', 'like']), S('laugh', 'Reactions', ['lol', 'haha']), S('thumbs-up', 'Reactions', ['like', 'yes']),
  S('hello', 'Haven', ['hi', 'wave']), S('lol', 'Haven', ['laugh']),
  S('cat', 'Mine'), S('dog', 'Animals'),
];
const PACKS = [{ name: 'Reactions', icon: '/uploads/stickers/heart.svg' }, { name: 'Haven', icon: '/uploads/stickers/hello.svg' }, { name: 'Gone', icon: '/x.svg' }];

test('pack tabs: built-in packs in server order, then uploaded packs by name', () => {
  const tabs = M._stickerPackTabs(STICKERS, PACKS);
  assert.deepEqual(tabs.map(t => t.name), ['Reactions', 'Haven', 'Animals', 'Mine']);
  assert.equal(tabs[0].icon, '/uploads/stickers/heart.svg');
  assert.equal(tabs[2].icon, '/uploads/stickers/dog.svg', 'an uploaded pack shows its first sticker');
  assert.deepEqual(tabs[1].stickers.map(s => s.name), ['hello', 'lol']);
  assert.deepEqual(M._stickerPackTabs([S('x', '')], undefined).map(t => t.name), ['General']);
});

test('search ranks the name over keywords, and every word has to match', () => {
  assert.deepEqual(M._stickerSearch(STICKERS, 'lol').map(s => s.name), ['lol', 'laugh']);
  assert.deepEqual(M._stickerSearch(STICKERS, 'like').map(s => s.name), ['heart', 'thumbs-up']);
  assert.deepEqual(M._stickerSearch(STICKERS, 'up').map(s => s.name), ['thumbs-up']);
  assert.deepEqual(M._stickerSearch(STICKERS, ':heart:').map(s => s.name), ['heart']);
  assert.deepEqual(M._stickerSearch(STICKERS, 'like yes').map(s => s.name), ['thumbs-up']);
  assert.deepEqual(M._stickerSearch(STICKERS, 'hav').map(s => s.name), ['hello', 'lol'], 'pack names match too');
  assert.deepEqual(M._stickerSearch(STICKERS, 'zebra'), []);
  assert.deepEqual(M._stickerSearch(STICKERS, '   '), []);
});

test('recents: newest first, no repeats, at most 16, only stickers that still exist', () => {
  const store = new Map();
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    M._rememberSticker('/uploads/stickers/heart.svg');
    M._rememberSticker('/uploads/stickers/cat.svg');
    M._rememberSticker('/uploads/stickers/heart.svg');
    M._rememberSticker('/uploads/stickers/deleted.svg');
    assert.deepEqual(M._recentStickers(STICKERS).map(s => s.name), ['heart', 'cat']);
    for (let i = 0; i < 30; i++) M._rememberSticker(`/uploads/stickers/n${i}.png`);
    assert.equal(M._recentStickerUrls().length, 16);
    store.set('haven_recent_stickers', '{not json');
    assert.deepEqual(M._recentStickerUrls(), []);
  } finally {
    delete global.localStorage;
  }
  assert.deepEqual(M._recentStickerUrls(), [], 'no storage at all is fine');
});

test('a moving sticker rests on #still unless the viewer animates chat', () => {
  const app = Object.assign({}, M, { _viewerChatAnimPref: () => 'hover' });
  assert.equal(app._stickerThumbSrc(S('heart', 'R', [], { animated: true })), '/uploads/stickers/heart.svg#still');
  assert.equal(app._stickerThumbSrc(S('skull', 'R')), '/uploads/stickers/skull.svg', 'still drawings are left alone');
  app._viewerChatAnimPref = () => 'always';
  assert.equal(app._stickerThumbSrc(S('heart', 'R', [], { animated: true })), '/uploads/stickers/heart.svg');
});

test('freezing a sticker SVG in chat uses its resting frame, no canvas', async () => {
  assert.equal(A._isStickerSvg('/uploads/stickers/starter-fire.svg'), true);
  assert.equal(A._isStickerSvg('/uploads/stickers/starter-fire.svg#still'), true);
  assert.equal(A._isStickerSvg('/uploads/elsewhere.svg'), false);
  assert.equal(A._isStickerSvg('/uploads/stickers/wave.png'), false);
  assert.equal(A._animCanAnimate('/uploads/stickers/builtin-reactions-heart.svg'), true);
  assert.equal(await A._frozenFrame('/uploads/stickers/builtin-reactions-heart.svg'), '/uploads/stickers/builtin-reactions-heart.svg#still');
});

'use strict';

// theme.js runs in a small fake page here: enough DOM for the theme picker
// and the Custom editor, so the tests can see which colors end up on :root.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const THEME_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    has: key => values.has(key),
  };
}

function inlineStyle() {
  const props = new Map();
  return {
    props,
    setProperty: (key, value) => { props.set(key, String(value)); },
    removeProperty: key => { props.delete(key); },
    getPropertyValue: key => props.get(key) || '',
  };
}

function element(id) {
  const attributes = new Map();
  return {
    id,
    style: inlineStyle(),
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute: (name, value) => { attributes.set(name, String(value)); },
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: name => { attributes.delete(name); },
    hasAttribute: name => attributes.has(name),
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild: child => child,
  };
}

// A 2D context that accepts every drawing call and draws nothing.
function canvasContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createImageData') return () => ({ data: [] });
      return () => {};
    },
  });
}

function canvas(id) {
  return Object.assign(element(id), {
    width: 12,
    height: 12,
    getContext: () => canvasContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 12, height: 12 }),
  });
}

function loadThemePage(stored = {}) {
  const localStorage = memoryStorage(stored);
  const sessionStorage = memoryStorage();
  const root = element('html');
  const nodes = new Map([
    ['theme-selector', element('theme-selector')],
    ['custom-theme-editor', element('custom-theme-editor')],
    ['custom-hue-bar', canvas('custom-hue-bar')],
    ['custom-triangle', canvas('custom-triangle')],
    ['custom-theme-swatch', element('custom-theme-swatch')],
  ]);
  const timers = [];
  const document = {
    documentElement: root,
    body: element('body'),
    head: element('head'),
    hidden: false,
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: tag => element(tag),
    addEventListener() {},
  };
  const window = {
    location: { href: 'http://localhost/app', search: '' },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const context = {
    window,
    document,
    localStorage,
    sessionStorage,
    console,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '', color: '' }),
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  window.document = document;
  window.localStorage = localStorage;
  vm.createContext(context);
  vm.runInContext(THEME_SOURCE, context, { filename: 'theme.js' });
  const runTimers = () => { while (timers.length) timers.shift()(); };
  return { context, root, nodes, localStorage, runTimers };
}

test('a fresh account keeps Haven colors instead of the Custom palette', () => {
  const page = loadThemePage();
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();

  assert.equal(page.root.style.props.get('--bg-primary'), undefined, 'no Custom color on :root');
  assert.equal(page.root.style.props.get('--accent'), undefined, 'no Custom accent on :root');
  assert.equal(page.localStorage.has('haven_custom_hsv'), false, 'loading the page does not save a Custom color');
  assert.ok(page.nodes.get('custom-theme-swatch').style.background, 'the Custom button still shows its color');
});

test('a built-in theme is not covered by a Custom color saved earlier', () => {
  const page = loadThemePage({
    haven_theme: 'discord',
    haven_custom_hsv: JSON.stringify({ h: 120, s: 0.8, v: 0.9 }),
  });
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();

  assert.equal(page.root.style.props.get('--bg-primary'), undefined);
});

test('an account that chose Custom keeps its Custom palette', () => {
  const hsv = { h: 120, s: 0.8, v: 0.9 };
  const page = loadThemePage({ haven_theme: 'custom', haven_custom_hsv: JSON.stringify(hsv) });
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();

  const expected = page.context.generateCustomPalette(hsv.h, hsv.s, hsv.v, hsv.s, false);
  assert.equal(page.root.style.props.get('--bg-primary'), expected['--bg-primary']);
  assert.equal(page.root.style.props.get('--accent'), expected['--accent']);
});

test('Custom chosen from the server applies even before a color was ever saved', () => {
  const page = loadThemePage();
  page.context.initThemeSwitcher('theme-selector');
  page.runTimers();
  page.context.applyThemeFromServer('custom', true, true);

  assert.ok(page.root.style.props.get('--bg-primary'), 'the default Custom palette is applied');
  assert.equal(page.localStorage.getItem('haven_theme'), 'custom');
});

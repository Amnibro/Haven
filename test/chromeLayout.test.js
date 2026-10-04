'use strict';

/**
 * Tests for ChromeLayout layout plugin.
 *
 *   node --test test/chromeLayout.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ChromeLayout = require('../plugins/ChromeLayout.plugin.js');

const ROOT = path.join(__dirname, '..');

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener.call(this, event);
    }
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(property, value, priority = '') {
    this.values.set(property, { value, priority });
  }

  removeProperty(property) {
    this.values.delete(property);
  }

  getPropertyValue(property) {
    return this.values.get(property)?.value || '';
  }

  getPropertyPriority(property) {
    return this.values.get(property)?.priority || '';
  }
}

class FakeElement extends FakeTarget {
  constructor(name, registry = null) {
    super();
    this.name = name;
    this._registry = registry;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = new FakeStyle();
    this._classes = new Set();
    const self = this;
    this.classList = {
      add(...names) { names.forEach(name => self._classes.add(name)); },
      remove(...names) { names.forEach(name => self._classes.delete(name)); },
      contains(name) { return self._classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !self._classes.has(name) : Boolean(force);
        if (enabled) self._classes.add(name); else self._classes.delete(name);
        return enabled;
      }
    };
    this.textContent = '';
    this.title = '';
    this.type = '';
    this._id = '';
    this.hidden = false;
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(names) {
    this._classes.clear();
    String(names || '').split(/\s+/).filter(Boolean).forEach(n => this._classes.add(n));
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = value;
    if (this._registry) this._registry.set(value, this);
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }

  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  prepend(node) {
    this.insertBefore(node, this.firstChild);
  }

  insertBefore(node, reference) {
    if (reference && reference.parentNode !== this) throw new Error('Invalid insertion reference');
    if (node.parentNode) {
      const previousIndex = node.parentNode.children.indexOf(node);
      node.parentNode.children.splice(previousIndex, 1);
    }
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  remove() {
    if (this._registry && this._id) {
      this._registry.delete(this._id);
    }
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = value;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return { left: 100, top: 100, right: 150, bottom: 150, width: 50, height: 50 };
  }

  querySelector(sel) {
    for (const child of this.children) {
      if (matchesSelector(child, sel)) return child;
      const found = child.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(sel) {
    const results = [];
    for (const child of this.children) {
      if (matchesSelector(child, sel)) results.push(child);
      results.push(...child.querySelectorAll(sel));
    }
    return results;
  }

  contains(el) {
    if (!el) return false;
    let curr = el;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
}

function matchesSimple(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel === 'h5') return el.name === 'h5';
  if (sel.startsWith('[data-action="') && sel.endsWith('"]')) {
    const action = sel.slice(14, -2);
    return el.dataset?.action === action;
  }
  return false;
}

function matchesSelector(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (parts.length === 1) return matchesSimple(el, parts[0]);
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let curr = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (curr && !matchesSimple(curr, parts[i])) {
      curr = curr.parentNode;
    }
    if (!curr) return false;
    curr = curr.parentNode;
  }
  return true;
}

function createEnvironment() {
  const elementsById = new Map();
  const document = new FakeTarget();
  document.documentElement = new FakeElement('html', elementsById);
  document.body = new FakeElement('body', elementsById);
  document.documentElement.appendChild(document.body);

  document.getElementById = (id) => elementsById.get(id) || null;
  document.createElement = (name) => {
    return new FakeElement(name, elementsById);
  };
  document.querySelector = (sel) => document.documentElement.querySelector(sel);
  document.querySelectorAll = (sel) => document.documentElement.querySelectorAll(sel);

  const add = (id, el) => {
    el.id = id;
    elementsById.set(id, el);
    return el;
  };

  const appBody = add('app-body', new FakeElement('div', elementsById));
  document.body.appendChild(appBody);

  const sidebar = new FakeElement('aside', elementsById);
  sidebar.classList.add('sidebar');
  appBody.appendChild(sidebar);

  const channelsToggle = add('channels-toggle', new FakeElement('h5', elementsById));
  channelsToggle.classList.add('channels-toggle');
  sidebar.appendChild(channelsToggle);

  const subBtn = add('sub-channel-panel-btn', new FakeElement('button', elementsById));
  const orgBtn = add('organize-channels-btn', new FakeElement('button', elementsById));
  channelsToggle.append(subBtn, orgBtn);

  const channelList = add('channel-list', new FakeElement('div', elementsById));
  channelList.classList.add('channel-list');
  sidebar.appendChild(channelList);

  const row = new FakeElement('div', elementsById);
  row.classList.add('channel-item');
  row.dataset.channelCode = 'general';
  const moreBtn = new FakeElement('button', elementsById);
  moreBtn.classList.add('channel-more-btn');
  row.appendChild(moreBtn);
  channelList.appendChild(row);

  const bottomBar = new FakeElement('div', elementsById);
  bottomBar.classList.add('sidebar-bottom-bar');
  sidebar.appendChild(bottomBar);

  const threadsBtn = add('threads-toggle-btn', new FakeElement('button', elementsById));
  sidebar.appendChild(threadsBtn);

  const dmPane = add('dm-pane', new FakeElement('div', elementsById));
  dmPane.classList.add('dm-section-pane');
  const dmHeader = add('dm-toggle-header', new FakeElement('h5', elementsById));
  const dmArrow = add('dm-toggle-arrow', new FakeElement('span', elementsById));
  const dmList = add('dm-list', new FakeElement('div', elementsById));
  dmHeader.appendChild(dmArrow);
  dmPane.append(dmHeader, dmList);
  sidebar.appendChild(dmPane);

  const homeServer = add('home-server', new FakeElement('div', elementsById));
  homeServer.classList.add('server-icon');
  appBody.appendChild(homeServer);

  const styles = new Map();
  const data = new Map();
  let layoutOwner = null;

  const HavenApi = {
    DOM: {
      addStyle(id, css) { styles.set(id, css); },
      removeStyle(id) { styles.delete(id); },
      query(sel) { return document.querySelector(sel); },
      queryAll(sel) { return document.querySelectorAll(sel); }
    },
    Layout: {
      acquire(owner) {
        if (layoutOwner && layoutOwner !== owner) return false;
        layoutOwner = owner;
        document.documentElement.setAttribute('data-haven-layout-owner', owner);
        document.dispatchEvent({ type: 'haven:layout-owner-change', detail: { owner } });
        return true;
      },
      release(owner) {
        if (layoutOwner !== owner) return false;
        layoutOwner = null;
        document.documentElement.removeAttribute('data-haven-layout-owner');
        document.dispatchEvent({ type: 'haven:layout-owner-change', detail: { owner: null } });
        return true;
      },
      get owner() { return layoutOwner; }
    },
    Data: {
      save(plugin, key, val) {
        if (!data.has(plugin)) data.set(plugin, new Map());
        data.get(plugin).set(key, val);
      },
      load(plugin, key, fallback = null) {
        return data.get(plugin)?.get(key) ?? fallback;
      }
    }
  };

  const app = {
    user: { isAdmin: true },
    channels: [{ code: 'general', name: 'General', voice_enabled: 1 }],
    unreadCounts: { general: 0 },
    voice: { inVoice: false, currentChannel: null }
  };

  return { document, HavenApi, app, styles, data, elementsById };
}

function withEnv(fn) {
  const env = createEnvironment();
  const prevDoc = global.document;
  const prevHaven = global.HavenApi;
  const prevApp = global.app;
  const prevWindow = global.window;

  global.document = env.document;
  global.HavenApi = env.HavenApi;
  global.app = env.app;
  global.window = { app: env.app, HavenApi: env.HavenApi, innerWidth: 1200 };

  try {
    fn(env);
  } finally {
    global.document = prevDoc;
    global.HavenApi = prevHaven;
    global.app = prevApp;
    global.window = prevWindow;
  }
}

test('ChromeLayout file and class meet the Layout Picker requirements', () => {
  const source = fs.readFileSync(path.join(ROOT, 'plugins/ChromeLayout.plugin.js'), 'utf8');

  assert.match(source, /@name Chrome Layout/);
  assert.match(source, /class ChromeLayout/);
  assert.match(source, /_engage\(/);
  assert.match(source, /_disengage\(/);
  assert.match(source, /acquire\(['"]ChromeLayout['"]\)/);
  assert.match(source, /layoutOn/);
});

test('ChromeLayout engages and injects prominent +, dock buttons, and channel voice buttons', () => {
  withEnv(({ document, HavenApi }) => {
    const plugin = new ChromeLayout();
    plugin.start();

    assert.equal(document.documentElement.getAttribute('data-chrome-layout'), '1');
    assert.equal(HavenApi.Layout.owner, 'ChromeLayout');

    // Prominent + button injected
    const addBtn = document.getElementById('channel-actions-btn');
    assert.ok(addBtn, '#channel-actions-btn should be injected');
    assert.ok(addBtn.classList.contains('channel-actions-add-btn'), 'should have class channel-actions-add-btn');
    assert.ok(addBtn.classList.contains('chrome-chip'), 'should have class chrome-chip');

    // Sheet menu injected
    const menu = document.getElementById('channel-actions-menu');
    assert.ok(menu, '#channel-actions-menu should be injected');
    assert.equal(menu.hidden, true);

    // Footer dock injected
    const peopleBtn = document.getElementById('people-dock-btn');
    const dmBtn = document.getElementById('dm-dock-btn');
    assert.ok(peopleBtn, '#people-dock-btn should be injected');
    assert.ok(dmBtn, '#dm-dock-btn should be injected');

    // Channel voice button injected on channel row
    const row = document.querySelector('.channel-item');
    const voiceBtn = row.querySelector('.channel-join-voice');
    assert.ok(voiceBtn, '.channel-join-voice should be injected on channel item');
    assert.equal(voiceBtn.dataset.joinVoice, 'general');

    // Home server menu bound
    const homeMenu = document.getElementById('home-server-menu');
    assert.ok(homeMenu, '#home-server-menu should exist');

    plugin.stop();

    // Clean teardown on stop
    assert.equal(document.documentElement.hasAttribute('data-chrome-layout'), false);
    assert.equal(HavenApi.Layout.owner, null);
    assert.equal(document.getElementById('channel-actions-btn'), null);
    assert.equal(document.getElementById('channel-actions-menu'), null);
    assert.equal(document.getElementById('people-dock-btn'), null);
    assert.equal(document.getElementById('dm-dock-btn'), null);
    assert.equal(document.getElementById('home-server-menu'), null);
    assert.equal(row.querySelector('.channel-join-voice'), null);
  });
});

test('ChromeLayout respects structural layout owner exclusivity', () => {
  withEnv(({ HavenApi }) => {
    // Another layout owns the layout
    HavenApi.Layout.acquire('BraidLayout');

    const plugin = new ChromeLayout();
    plugin.start();

    assert.equal(HavenApi.Layout.owner, 'BraidLayout');
    assert.equal(plugin._engaged, false);
    assert.equal(plugin._blocked, true);

    // Release and retry
    HavenApi.Layout.release('BraidLayout');
    assert.equal(HavenApi.Layout.owner, 'ChromeLayout');
    assert.equal(plugin._engaged, true);

    plugin.stop();
    assert.equal(HavenApi.Layout.owner, null);
  });
});

test('ChromeLayout suspends during Mod Mode and resumes when editing ends', () => {
  withEnv(({ document, HavenApi }) => {
    const plugin = new ChromeLayout();
    plugin.start();

    assert.equal(plugin._engaged, true);
    assert.equal(HavenApi.Layout.owner, 'ChromeLayout');
    assert.equal(document.documentElement.getAttribute('data-chrome-layout'), '1');

    // Mod Mode editing starts
    document.documentElement.setAttribute('data-haven-layout-editing', '1');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: true } });

    assert.equal(plugin._suspended, true);
    assert.equal(HavenApi.Layout.owner, null);
    assert.equal(document.documentElement.hasAttribute('data-chrome-layout'), false);

    // Mod Mode editing finishes
    document.documentElement.removeAttribute('data-haven-layout-editing');
    document.dispatchEvent({ type: 'haven:layout-editing', detail: { active: false } });

    assert.equal(plugin._suspended, false);
    assert.equal(HavenApi.Layout.owner, 'ChromeLayout');
    assert.equal(document.documentElement.getAttribute('data-chrome-layout'), '1');

    plugin.stop();
  });
});

test('ChromeLayout rolls back ownership and attributes when persistence fails', () => {
  withEnv(({ document, HavenApi }) => {
    const plugin = new ChromeLayout();
    HavenApi.Data.save = () => { throw new Error('disk quota exceeded'); };

    assert.throws(() => plugin._engage(true), /disk quota exceeded/);
    assert.equal(plugin._engaged, false);
    assert.equal(HavenApi.Layout.owner, null);
    assert.equal(document.documentElement.hasAttribute('data-chrome-layout'), false);
  });
});

test('ChromeLayout CSS is properly scoped to [data-chrome-layout="1"]', () => {
  const css = ChromeLayout.CSS;
  assert.match(css, /html\[data-chrome-layout="1"\] \.category-label/);
  assert.match(css, /html\[data-chrome-layout="1"\] \.channels-toggle \.channel-actions-add-btn/);
  assert.match(css, /html\[data-chrome-layout="1"\] #dm-dock-btn/);
  assert.match(css, /html\[data-chrome-layout="1"\] #people-dock-btn/);
  assert.match(css, /html\[data-chrome-layout="1"\] \.channel-join-voice/);
  assert.match(css, /html\[data-chrome-layout="1"\] \.home-server-menu/);
  assert.match(css, /html\[data-chrome-layout="1"\] \.sidebar-split-handle/);
  assert.match(css, /#braid-return-pill/);
  assert.match(css, /\[data-compact-layout-control\]/);
});

test('ChromeLayout DM drawer collapses down when toggle header is clicked', () => {
  withEnv(({ document }) => {
    const plugin = new ChromeLayout();
    plugin.start();

    // Open DM dock
    plugin._setDmDockOpen(true);
    assert.equal(document.documentElement.classList.contains('dms-open'), true);

    const dmHeader = document.getElementById('dm-toggle-header');
    assert.ok(dmHeader);

    // Clicking header collapses down the DM drawer
    dmHeader.dispatchEvent({ type: 'click', target: dmHeader });
    assert.equal(document.documentElement.classList.contains('dms-open'), false);

    plugin.stop();
  });
});


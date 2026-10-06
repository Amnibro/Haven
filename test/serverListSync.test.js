'use strict';

// The server list in Haven Desktop: every server page keeps its own copy in
// its own browser storage, and the Desktop app keeps the shared one. These
// tests load servers.js once per server page, with its own storage, against
// one fake Desktop app, and check the pages agree.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Values from the page's context are compared as plain data.
const plain = v => JSON.parse(JSON.stringify(v));
const urls = list => plain(list.map(s => s.url));

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/servers.js'), 'utf8');

function createStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function norm(url) {
  const u = new URL(/^https?:\/\//.test(url) ? url : 'https://' + url);
  const p = u.pathname.replace(/\/+$/, '').replace(/\/app(?:\.html)?$/i, '');
  return p ? u.origin + p : u.origin;
}

// A stand-in for the Desktop app's shared list with the same rules as
// Haven Desktop's src/main/server-list.js.
function fakeDesktopStore() {
  const s = { history: [], removed: [], order: [] };
  const orderedUrls = () => {
    const known = new Set(s.history.map(h => h.url));
    const out = s.order.filter(u => known.has(u));
    for (const h of s.history) if (!out.includes(h.url)) out.push(h.url);
    return out;
  };
  const view = () => {
    const byUrl = new Map(s.history.map(h => [h.url, h]));
    const order = orderedUrls();
    return JSON.parse(JSON.stringify({ servers: order.map(u => byUrl.get(u)), removed: s.removed, order, hasOrder: s.order.length > 0 }));
  };
  return {
    state: s,
    view,
    add(url, name, opts) {
      url = norm(url);
      if (s.removed.includes(url)) {
        if (!(opts && opts.userInitiated)) return 'refused';
        s.removed = s.removed.filter(u => u !== url);
      }
      if (s.history.some(h => h.url === url)) return 'exists';
      s.history.push({ url, name: name || url, lastConnected: 0 });
      return 'added';
    },
    remove(url) {
      url = norm(url);
      s.history = s.history.filter(h => h.url !== url);
      s.order = s.order.filter(u => u !== url);
      if (!s.removed.includes(url)) s.removed.push(url);
    },
    rename(url, name, opts = {}) {
      const e = s.history.find(h => h.url === norm(url));
      if (!e || !name) return false;
      if (typeof opts.custom !== 'boolean') {
        if (e.customName) return false;
        e.name = name;
        return true;
      }
      e.name = name;
      if (opts.custom) e.customName = true; else delete e.customName;
      if ('icon' in opts) {
        if (opts.icon) { e.icon = opts.icon; e.customIcon = true; } else { delete e.icon; delete e.customIcon; }
      }
      e.editedAt = opts.editedAt || Date.now();
      return true;
    },
    setOrder(urls) {
      const want = [...new Set(urls.map(norm))].filter(u => !s.removed.includes(u));
      const base = [...new Set([...s.order, ...orderedUrls()])];
      const inBase = want.filter(u => base.includes(u));
      let i = 0;
      s.order = base.map(u => (inBase.includes(u) ? inBase[i++] : u)).concat(want.filter(u => !base.includes(u)));
    },
  };
}

// The window.havenDesktop a page sees: new Desktop (shared list) or an old
// one that only has the plain history.
function desktopApi(store, { old = false } = {}) {
  const api = {
    calls: [],
    initialServerHistory: store.view().servers,
    getServerHistory: async () => store.view().servers,
    addServerHistory: async (url, name, opts) => { api.calls.push(['add', url]); return old ? undefined : store.add(url, name, opts); },
    removeServerHistory: async (url) => { api.calls.push(['remove', url]); store.remove(url); return store.view().servers; },
  };
  if (old) {
    // An old Desktop forgets removals and drops the third argument.
    api.addServerHistory = async (url, name) => { api.calls.push(['add', url]); store.state.removed = []; store.add(url, name); };
    return api;
  }
  api.initialServerList = store.view();
  api.getServerList = async () => store.view();
  api.setServerOrder = async (urls) => { store.setOrder(urls); return true; };
  api.updateServerName = async (url, name, opts) => store.rename(url, name, opts);
  return api;
}

// Health answers per server address: { name, fingerprint } or null (down).
function fakeFetch(origin, health) {
  return async (url) => {
    const full = url.startsWith('/') ? origin + url : url;
    if (full.endsWith('/api/health')) {
      const base = full.slice(0, -'/api/health'.length);
      // The page's own server always answers.
      const info = health[base] || (base === origin ? { name: 'Self', fingerprint: 'self:' + origin } : null);
      if (!info) throw new Error('offline');
      return { ok: true, json: async () => ({ status: 'online', name: info.name, icon: null, fingerprint: info.fingerprint }) };
    }
    throw new Error('unexpected fetch ' + full);
  };
}

/** Open a server page: servers.js in its own context with its own storage. */
function openPage(origin, { storage = createStorage(), desktop = null, health = {} } = {}) {
  const warnings = [];
  const window = desktop ? { havenDesktop: desktop } : {};
  const context = vm.createContext({
    window,
    localStorage: storage,
    location: { origin },
    fetch: fakeFetch(origin, health),
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {}, info() {}, error: (...a) => warnings.push(a.join(' ')) },
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Promise,
  });
  vm.runInContext(`${SOURCE}\nglobalThis.ServerManager = ServerManager;`, context, { filename: 'servers.js' });
  const manager = new context.ServerManager();
  return { manager, storage, warnings };
}

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const X = 'https://x.example.com';
const Y = 'https://y.example.com';
const Z = 'https://z.example.com';

function seeded(urls) {
  const store = fakeDesktopStore();
  for (const u of urls) store.add(u, u);
  return store;
}

function storageWith(urls) {
  return createStorage({ haven_servers: JSON.stringify(urls.map(u => ({ name: u, url: u, addedAt: 1 }))) });
}

test('a server removed on one server stays removed on another', async () => {
  const store = seeded([A, B, X, Y]);
  // Server B's own storage still has X from an earlier sync.
  const bStorage = storageWith([A, X, Y]);

  const a = openPage(A, { desktop: desktopApi(store), storage: storageWith([B, X, Y]) });
  await a.manager.reconcileWithDesktop();
  a.manager.remove(X);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(store.state.removed, [X]);

  const b = openPage(B, { desktop: desktopApi(store), storage: bStorage });
  assert.ok(!b.manager.servers.some(s => s.url === X), 'gone as soon as the page loads');
  const stats = await b.manager.reconcileWithDesktop();
  assert.equal(stats.added, 0);
  assert.ok(!b.manager.servers.some(s => s.url === X));
  assert.ok(!store.state.history.some(h => h.url === X), 'B does not hand it back to the app');
  assert.ok(!b.manager.add('X', X), 'a sync cannot add it back either');

  // Adding it on purpose brings it back for everyone.
  assert.ok(b.manager.add('X', X, null, { userInitiated: true }));
  assert.equal(store.add(X, 'X', { userInitiated: true }), 'added');
  const c = openPage(A, { desktop: desktopApi(store), storage: a.storage });
  await c.manager.reconcileWithDesktop();
  assert.ok(c.manager.servers.some(s => s.url === X));
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(b.warnings, []);
});

test('removals a server made before the shared list are handed over once', async () => {
  const store = seeded([A, B, X]);
  const storage = storageWith([B, X]);
  storage.setItem('haven_servers_removed', JSON.stringify([Y]));
  // On A, X was removed earlier but came back into the app's history.
  storage.setItem('haven_servers', JSON.stringify([{ name: 'B', url: B }]));
  storage.setItem('haven_servers_removed', JSON.stringify([X]));
  const a = openPage(A, { desktop: desktopApi(store), storage });
  assert.ok(!a.manager.servers.some(s => s.url === X), 'before the handover, this page keeps its removal');
  await a.manager.reconcileWithDesktop();
  assert.deepEqual(store.state.removed, [X]);
  assert.equal(storage.getItem('haven_servers_desktop_list'), '1');

  // Later, the user opens X again (which lifts the removal in the app); this
  // page now follows the app instead of its old removed set.
  store.state.removed = [];
  store.add(X, 'X');
  const again = openPage(A, { desktop: desktopApi(store), storage });
  await again.manager.reconcileWithDesktop();
  assert.ok(again.manager.servers.some(s => s.url === X));
});

test('a rename on one server shows on the others and the server name does not override it', async () => {
  const store = seeded([A, B, X]);
  const health = { [X]: { name: 'LIT', fingerprint: 'fx' } };
  const a = openPage(A, { desktop: desktopApi(store), storage: storageWith([B, X]), health });
  await a.manager.reconcileWithDesktop();
  assert.ok(a.manager.editByUser(X, { name: 'Red Earth' }));
  await new Promise(r => setImmediate(r));

  const b = openPage(B, { desktop: desktopApi(store), storage: storageWith([A, X]), health });
  const x = b.manager.servers.find(s => s.url === X);
  assert.equal(x.name, 'Red Earth', 'applied at page load');
  assert.equal(x.customName, true);
  await b.manager.reconcileWithDesktop();
  await b.manager.checkAll();
  assert.equal(x.name, 'Red Earth', 'the server reporting LIT does not replace the user name');

  // Going back to the server's own name lets it follow the server again.
  await b.manager.checkAll();
  assert.ok(b.manager.editByUser(X, { name: 'LIT' }));
  await new Promise(r => setImmediate(r));
  const a2 = openPage(A, { desktop: desktopApi(store), storage: a.storage, health });
  await a2.manager.reconcileWithDesktop();
  const ax = a2.manager.servers.find(s => s.url === X);
  assert.equal(ax.name, 'LIT');
  assert.ok(!ax.customName);
});

test('names follow the server everywhere when the user never chose one', async () => {
  const store = seeded([A, B, X, Y]);
  const health = {
    [X]: { name: 'LIT', fingerprint: 'fx' },
    [Y]: { name: 'Haven', fingerprint: 'fy' },
    [B]: { name: 'Haven', fingerprint: 'fb' },
  };
  // A list saved since 4.19 (its old names were already kept once).
  const bStorage = createStorage({ haven_servers: JSON.stringify([{ name: 'Red Earth', url: X }, { name: Y, url: Y }]), haven_servers_names_kept: '1' });
  const b = openPage(B, { desktop: desktopApi(store), storage: bStorage, health });
  await b.manager.reconcileWithDesktop();
  assert.equal(await b.manager.checkAll(), 1);
  assert.equal(b.manager.servers.find(s => s.url === X).name, 'LIT');
  assert.equal(b.manager.servers.find(s => s.url === Y).name, Y, 'the default name "Haven" is skipped');
  await new Promise(r => setImmediate(r));
  assert.equal(store.state.history.find(h => h.url === X).name, 'LIT');

  // A page that has never reached X (offline) still shows the real name.
  const a = openPage(A, { desktop: desktopApi(store), storage: storageWith([X]) });
  await a.manager.reconcileWithDesktop();
  assert.equal(a.manager.servers.find(s => s.url === X).name, 'LIT');
});

test('a name typed when adding a server is kept and shared as the user\'s own', async () => {
  const store = seeded([A, B]);
  const health = { [X]: { name: 'LIT', fingerprint: 'fx' } };
  const api = desktopApi(store);
  const a = openPage(A, { desktop: api, storage: storageWith([B]), health });
  await a.manager.reconcileWithDesktop();
  assert.ok(a.manager.add('Red Earth', X, null, { userInitiated: true, customName: true }));
  await api.addServerHistory(X, 'Red Earth', { userInitiated: true });
  await a.manager.shareName(X);
  await a.manager.checkAll();
  const x = a.manager.servers.find(s => s.url === X);
  assert.equal(x.name, 'Red Earth', 'the health check does not replace it');
  assert.equal(x.customName, true);
  const shared = store.state.history.find(h => h.url === X);
  assert.equal(shared.name, 'Red Earth');
  assert.equal(shared.customName, true, 'the Desktop list gets the custom flag');

  // Another page that renames from the server's report keeps the user name.
  const b = openPage(B, { desktop: desktopApi(store), storage: storageWith([A]), health });
  await b.manager.reconcileWithDesktop();
  await b.manager.checkAll();
  assert.equal(b.manager.servers.find(s => s.url === X).name, 'Red Earth');

  // An address or the default name typed in still follows the server.
  assert.ok(a.manager.add(Y, Y, null, { userInitiated: true, customName: true }));
  assert.ok(a.manager.add('Haven', Z, null, { userInitiated: true, customName: true }));
  assert.ok(!a.manager.servers.find(s => s.url === Y).customName);
  assert.ok(!a.manager.servers.find(s => s.url === Z).customName);
  assert.deepEqual(a.warnings, []);
});

test('names saved before 4.19 are kept once, and later lists are left alone', async () => {
  const health = { [X]: { name: 'LIT', fingerprint: 'fx' }, [Y]: { name: 'Why', fingerprint: 'fy' }, [Z]: { name: 'Zed', fingerprint: 'fz' } };
  const storage = createStorage({ haven_servers: JSON.stringify([
    { name: 'Red Earth', url: X, addedAt: 1 },
    { name: Y, url: Y, addedAt: 1 },
    { name: 'Haven', url: Z, addedAt: 1 },
  ]) });
  const page = openPage(A, { storage, health });
  await page.manager.checkAll();
  const byUrl = u => page.manager.servers.find(s => s.url === u);
  assert.equal(byUrl(X).name, 'Red Earth');
  assert.equal(byUrl(X).customName, true);
  assert.equal(byUrl(Y).name, 'Why', 'a bare address follows the server');
  assert.equal(byUrl(Z).name, 'Zed', 'the default name follows the server');
  assert.equal(storage.getItem('haven_servers_names_kept'), '1');
  assert.equal(JSON.parse(storage.getItem('haven_servers')).find(s => s.url === X).customName, true, 'saved');

  // Runs once: a name that followed the server later is not frozen.
  storage.setItem('haven_servers', JSON.stringify([{ name: 'Old', url: X, addedAt: 1 }]));
  const again = openPage(A, { storage, health });
  await again.manager.checkAll();
  assert.equal(again.manager.servers[0].name, 'LIT');

  // With the Desktop app, an edit made there wins over a kept old name,
  // and a kept old name reaches the app when it has no edit of its own.
  const store = seeded([A, X, Y]);
  store.rename(X, 'Desk Name', { custom: true, editedAt: 5 });
  const s2 = createStorage({ haven_servers: JSON.stringify([{ name: 'Red Earth', url: X }, { name: 'My Y', url: Y }]) });
  const d = openPage(A, { desktop: desktopApi(store), storage: s2, health });
  await d.manager.reconcileWithDesktop();
  assert.equal(d.manager.servers.find(s => s.url === X).name, 'Desk Name');
  const y = store.state.history.find(h => h.url === Y);
  assert.equal(y.name, 'My Y');
  assert.equal(y.customName, true);
});

test('a new order on one server shows on the others, and the hidden server keeps its place', async () => {
  const store = seeded([A, B, X, Y, Z]);
  const a = openPage(A, { desktop: desktopApi(store), storage: storageWith([A, B, X, Y, Z]) });
  await a.manager.reconcileWithDesktop();
  // The rail on A does not show A; the user drags Z to the top.
  a.manager.reorder([Z, B, X, Y]);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(urls(a.manager.servers), [A, Z, B, X, Y]);

  const b = openPage(B, { desktop: desktopApi(store), storage: storageWith([Y, X, A, Z]) });
  assert.deepEqual(urls(b.manager.servers), [A, Z, B, X, Y], 'applied at page load');
  await b.manager.reconcileWithDesktop();
  assert.deepEqual(urls(b.manager.servers), [A, Z, B, X, Y]);
});

test('the first page keeps its own order when the app has none yet', async () => {
  const store = seeded([X, Y, Z]);
  const a = openPage(A, { desktop: desktopApi(store), storage: storageWith([Z, Y, X]) });
  await a.manager.reconcileWithDesktop();
  assert.deepEqual(urls(a.manager.servers), [Z, Y, X]);
  assert.deepEqual(store.view().order, [Z, Y, X]);
});

test('one server under two addresses shows once in the rail and twice, with a note, in Manage Servers', async () => {
  const store = seeded([]);
  const L = 'https://localhost:3000';
  const D = 'https://anchaven.duckdns.org:3000';
  const health = {
    [L]: { name: 'Anc', fingerprint: 'same' },
    [D]: { name: 'Anc', fingerprint: 'same' },
    [X]: { name: 'LIT', fingerprint: 'fx' },
    [B]: { name: 'Bee', fingerprint: 'fb' },
  };
  const page = openPage(B, { desktop: desktopApi(store), storage: storageWith([L, D, X, B]), health });
  await page.manager.reconcileWithDesktop();
  await page.manager.selfFingerprintReady;
  await page.manager.checkAll();
  const rail = urls(page.manager.railServers(B));
  assert.deepEqual(rail, [L, X]);
  const manage = page.manager.otherServers(B);
  assert.deepEqual(urls(manage), [L, D, X]);
  assert.deepEqual(plain(manage[1].duplicateOf), { url: L, name: 'Anc' });
  assert.equal(manage[0].duplicateOf, undefined);
  assert.equal(page.manager.servers.length, 4, 'nothing is deleted');

  // On the server itself, both addresses are hidden as "this server".
  const self = openPage(L, { storage: storageWith([L, D, X]), health });
  await self.manager.selfFingerprintReady;
  await self.manager.checkAll();
  assert.deepEqual(urls(self.manager.railServers(L)), [X]);
});

test('an old Desktop app without the shared list still works as before', async () => {
  const store = seeded([A, B, X]);
  const api = desktopApi(store, { old: true });
  const page = openPage(A, { desktop: api, storage: storageWith([B, Y]) });
  assert.ok(page.manager.servers.some(s => s.url === X), 'bootstrap from the plain history');
  const stats = await page.manager.reconcileWithDesktop();
  assert.deepEqual({ ...stats }, { added: 0, removed: 0, renamed: 0 });
  await new Promise(r => setImmediate(r));
  assert.ok(store.state.history.some(h => h.url === Y), 'local servers reach the history');
  page.manager.remove(X);
  page.manager.reorder([Y, B]);
  assert.ok(page.manager.editByUser(B, { name: 'Bee' }));
  await new Promise(r => setImmediate(r));
  assert.ok(api.calls.some(c => c[0] === 'remove' && c[1] === X));
  // The page's own removed set keeps X out, as it always did.
  const again = openPage(A, { desktop: desktopApi(seeded([A, B, X]), { old: true }), storage: page.storage });
  await again.manager.reconcileWithDesktop();
  assert.ok(!again.manager.servers.some(s => s.url === X));
  assert.deepEqual(page.warnings, []);
});

test('in a browser without the Desktop app nothing is shared and nothing breaks', async () => {
  const page = openPage(A, { storage: storageWith([B, X]) });
  assert.deepEqual({ ...(await page.manager.reconcileWithDesktop()) }, { added: 0, removed: 0, renamed: 0 });
  page.manager.remove(X);
  page.manager.reorder([B]);
  assert.ok(page.manager.editByUser(B, { name: 'Bee' }));
  assert.deepEqual(plain(page.manager.servers.map(s => s.name)), ['Bee']);
  assert.deepEqual(JSON.parse(page.storage.getItem('haven_servers_removed')), [X]);
  assert.deepEqual(page.warnings, []);
});

test('the server bar uses the shared list and reports what Sync did', () => {
  const bar = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-server-bar.js'), 'utf8');
  assert.match(bar, /railServers\(window\.location\.origin\)/);
  assert.match(bar, /otherServers\(window\.location\.origin\)/);
  assert.match(bar, /t\('servers\.sync_updated', \{ added, removed, renamed \}\)/);
  assert.match(bar, /t\('servers\.sync_up_to_date'\)/);
  assert.match(bar, /addServerHistory\(finalUrl, name, \{ userInitiated: true \}\)/);
  assert.match(bar, /add\(name, url, icon, \{ userInitiated: true, customName: true \}\)/);
  assert.match(bar, /shareName\(finalUrl\)/);
  assert.doesNotMatch(bar, /servers\.sync_success/);
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));
  for (const key of ['sync_up_to_date', 'sync_updated', 'same_server_as']) assert.ok(en.servers[key], key);
});

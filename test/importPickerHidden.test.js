'use strict';

// The Discord import picker greys out channels the Ferry bot can't read (a
// private channel its role was never added to): no tick, a lock, and a hint
// saying what to do in Discord. They are left out of the fetch.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-discord-import.js'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));

function lookup(key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), EN);
}
function t(key, vars = {}) {
  const raw = lookup(key);
  if (typeof raw !== 'string') return key;
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''));
}
const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fakeElement() {
  return {
    className: '', style: {}, dataset: {}, children: [], textContent: '', _html: '',
    set innerHTML(v) { this._html = String(v); if (!v) this.children = []; },
    get innerHTML() { return this._html; },
    appendChild(el) { this.children.push(el); },
    querySelectorAll(sel) {
      if (sel === '.import-channel-row') return this.children.filter(c => c.className.split(' ').includes('import-channel-row'));
      return [];
    },
    querySelector(sel) {
      if (sel !== 'input[type="checkbox"]') return null;
      const m = this._html.match(/<input type="checkbox" (\w+)>/);
      return m ? { checked: m[1] === 'checked', disabled: m[1] === 'disabled' } : null;
    },
  };
}

function load(response) {
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, fakeElement()); return els.get(id); },
    createElement: () => fakeElement(),
  };
  const sent = [];
  const fetch = async (url, opts) => {
    sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/import/discord/guild-channels') return { ok: true, json: async () => response };
    return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'stop here' }) };
  };
  const context = vm.createContext({ module: {}, document, fetch, t, window: { t }, setTimeout, JSON });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context);
  const app = Object.assign({}, context.module.exports, {
    token: 'x', _importAuth: { useFerry: true }, _escapeHtml: escapeHtml, _showToast() {},
  });
  return { app, els, sent };
}

const response = {
  channels: [
    { id: '1', name: 'general', topic: '', category: null, type: 'text', tags: [], readable: true },
    { id: '2', name: 'secret', topic: '', category: 'Staff', type: 'text', tags: [], readable: false },
    { id: '3', name: 'news', topic: '', category: 'Staff', type: 'announcement', tags: [] },
  ],
  threads: [{ id: '4', name: 'plans', parentId: '2', tags: [], readable: false }],
};

test('unreadable channels and their threads are greyed out with a hint, the rest stay ticked', async () => {
  const { app, els } = load(response);
  await app._importPickGuild({ id: '99', name: 'Guild' });
  const rows = els.get('import-connect-channel-list').querySelectorAll('.import-channel-row');
  const byId = Object.fromEntries(rows.map(r => [r.dataset.channelId, r]));

  for (const id of ['2', '4']) {
    assert.ok(byId[id].className.includes('import-channel-blocked'), `row ${id} is greyed out`);
    assert.deepEqual(byId[id].querySelector('input[type="checkbox"]'), { checked: false, disabled: true });
    assert.match(byId[id].innerHTML, /🔒/);
    assert.ok(byId[id].innerHTML.includes(escapeHtml(t('modals.discord_import.channel_hidden'))));
  }
  for (const id of ['1', '3']) {
    assert.ok(!byId[id].className.includes('import-channel-blocked'), `row ${id} is normal (unknown counts as readable)`);
    assert.equal(byId[id].querySelector('input[type="checkbox"]').checked, true);
  }
  const status = els.get('import-fetch-status');
  assert.notEqual(status.style.display, 'none');
  assert.match(status.textContent, /^🔒 2 channels are greyed out/);
});

test('greyed-out rows are left out of the fetch, and the guild id goes along', async () => {
  const { app, sent } = load(response);
  await app._importPickGuild({ id: '99', name: 'Guild' });
  await app._importConnectFetch();
  const req = sent.find(s => s.url === '/api/import/discord/fetch');
  assert.ok(req, 'the fetch was sent');
  assert.deepEqual(req.body.channels.map(c => c.id), ['1', '3']);
  assert.equal(req.body.guildId, '99');
  assert.equal(req.body.useFerry, true);
});

test('with nothing hidden the status line goes away', async () => {
  const { app, els } = load({ channels: [response.channels[0]], threads: [] });
  await app._importPickGuild({ id: '99', name: 'Guild' });
  assert.equal(els.get('import-fetch-status').style.display, 'none');
});

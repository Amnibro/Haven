'use strict';

// _proxyMediaUrl used to pass anything that did not start with http(s):// straight
// through, but the browser also sends //host/x.png, /\host/x.png and
// https:\\host/x.png to another host, so those skipped the media proxy and
// leaked the viewer's IP.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', 'app-utilities.js');
let U;
test.before(async () => {
  globalThis.location = { href: 'https://haven.example/app', origin: 'https://haven.example' };
  const mod = (await import(pathToFileURL(modulePath).href)).default;
  U = Object.assign({}, mod, { _mediaProxyEnabled: true, _mediaToken: 'tok' });
});
test.after(() => { delete globalThis.location; });

const proxied = (out, host) => {
  assert.ok(out.startsWith('/api/media-proxy?url='), 'proxied: ' + out);
  assert.equal(new URL(decodeURIComponent(out.split('url=')[1].split('&')[0])).host, host);
};

test('remote spellings the browser treats as another host are proxied', () => {
  proxied(U._proxyMediaUrl('https://evil.example/a.png'), 'evil.example');
  proxied(U._proxyMediaUrl('//evil.example/a.png'), 'evil.example');
  proxied(U._proxyMediaUrl('/\\evil.example/a.png'), 'evil.example');
  proxied(U._proxyMediaUrl('https:\\\\evil.example/a.png'), 'evil.example');
  proxied(U._proxyMediaUrl('HTTP://evil.example/a.png'), 'evil.example');
});

test('local paths, data and blob stay as they are', () => {
  assert.equal(U._proxyMediaUrl('/uploads/a.png'), '/uploads/a.png');
  assert.equal(U._proxyMediaUrl('https://haven.example/uploads/a.png'), 'https://haven.example/uploads/a.png');
  assert.equal(U._proxyMediaUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(U._proxyMediaUrl('blob:https://haven.example/1234'), 'blob:https://haven.example/1234');
});

test('other schemes are dropped', () => {
  assert.equal(U._proxyMediaUrl('javascript:alert(1)'), '');
  assert.equal(U._proxyMediaUrl('ftp://evil.example/a.png'), '');
  assert.equal(U._proxyMediaUrl('file:///etc/passwd'), '');
});

test('waits for the token, and goes direct only when the admin turned the proxy off', () => {
  assert.equal(Object.assign({}, U, { _mediaToken: null })._proxyMediaUrl('//evil.example/a.png'), null);
  assert.equal(Object.assign({}, U, { _mediaProxyEnabled: false })._proxyMediaUrl('//evil.example/a.png'), 'https://evil.example/a.png');
});

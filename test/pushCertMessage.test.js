'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-context.js'), 'utf8');
async function pushReason(error, tlsIssue) {
  const fetched = [];
  const context = vm.createContext({
    module: { exports: {} },
    console: { error() {}, warn() {}, log() {} },
    t: key => key,
    document: { getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    window: { isSecureContext: true, PushManager: function () {}, matchMedia: () => ({ matches: false }) },
    navigator: { userAgent: 'Chrome', platform: 'Linux', maxTouchPoints: 0, serviceWorker: { register: async () => { throw error; } } },
    fetch: async url => { fetched.push(url); return { json: async () => ({ tls_issue: tlsIssue }) }; },
  });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-context.js' });
  const app = Object.assign(Object.create(null), context.module.exports, { _showPushError(reason) { this.shown = reason; } });
  await app._setupPushNotifications();
  return { reason: app._pushErrorReason, fetched };
}
const sslError = Object.assign(new Error('Failed to register a ServiceWorker: An SSL certificate error occurred when fetching the script.'), { name: 'SecurityError' });
test('an incomplete certificate chain is named instead of blaming a self-signed certificate', async () => {
  assert.equal((await pushReason(sslError, 'missing_chain')).reason, 'context.push_error.ssl_chain');
  assert.equal((await pushReason(sslError, 'untrusted')).reason, 'context.push_error.ssl_untrusted');
  assert.equal((await pushReason(sslError, 'expired')).reason, 'context.push_error.ssl_expired');
  assert.equal((await pushReason(sslError, 'self_signed')).reason, 'context.push_error.ssl_required');
  assert.equal((await pushReason(sslError, null)).reason, 'context.push_error.ssl_required');
});
test('a service worker failure that is not about the certificate shows the real error', async () => {
  const r = await pushReason(new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (404) was received when fetching the script.'), 'missing_chain');
  assert.equal(r.reason, 'context.push_error.service_worker');
  assert.deepEqual(r.fetched, []);
});

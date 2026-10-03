'use strict';

// Use the actual route handlers on loopback to check the HTTP authorization
// boundary. The updater is a stub here; file/download behavior lives in the
// unit tests. Flip admin status during apply to model an in-flight demotion.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

test('admin API rejects anonymous and non-admin callers and rechecks authorization at apply', async t => {
  const app = express();
  app.use(express.json());
  let admin = true;
  let invoked = 0;
  // Register the production routes with isolated dependencies, without
  // starting voice services or opening a user DB.
  require('../src/routes/extensionUpdates')({
    app,
    verifyToken: token => token === 'scoped' ? { id: 'admin', purpose: 'connect' } : { id: token },
    verifyAdminFromDb: user => user.id === 'admin' && admin,
    extensionUpdater: {
      check: async () => { invoked++; return {}; },
      apply: async (token, user, authorized) => {
        admin = false;
        assert.equal(authorized(), false);
        throw new Error('Administrator permission is required.');
      },
    },
    late: { io: { emit() { assert.fail('failed update must not notify clients'); } } },
  });
  // server.js registers them with the same dependencies.
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(serverSource, /require\('\.\/src\/routes\/extensionUpdates'\)\(\{ app, verifyToken, verifyAdminFromDb, extensionUpdater, late \}\)/);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/extensions`;
  assert.equal((await fetch(url + '/check', { method: 'POST' })).status, 401);
  assert.equal(
    (await fetch(url + '/check', { method: 'POST', headers: { Authorization: 'Bearer member' } })).status,
    403,
  );
  assert.equal((await fetch(url + '/check', { method: 'POST', headers: { Authorization: 'Bearer scoped' } })).status, 401);
  assert.equal(invoked, 0);
  assert.equal(
    (await fetch(url + '/check', { method: 'POST', headers: { Authorization: 'Bearer admin' } })).status,
    200,
  );
  assert.equal(
    (await fetch(url + '/apply', { method: 'POST', headers: { Authorization: 'Bearer admin' } })).status,
    400,
  );
});

test('a successful update broadcasts a reload notification to connected clients', async t => {
  const app = express();
  app.use(express.json());
  const emitted = [];
  require('../src/routes/extensionUpdates')({
    app,
    verifyToken: () => ({ id: 'admin' }),
    verifyAdminFromDb: () => true,
    extensionUpdater: {
      check: async () => ({}),
      apply: async (token, user, authorized) => {
        assert.equal(token, 'approved-offer');
        assert.equal(user, 'admin');
        assert.equal(authorized(), true);
        return { version: '1.1.0', reloadRequired: true };
      },
    },
    late: { io: { emit(event) { emitted.push(event); } } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/admin/extensions/apply`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'approved-offer' }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(emitted, ['extensions-updated']);
});

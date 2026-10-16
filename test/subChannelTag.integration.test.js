'use strict';

/**
 * A sub-channel can be given its Organize tag when it is made, with the same
 * rules as tagging it afterwards (set-channel-category).
 *
 *   node --test test/subChannelTag.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const PORT = 3494;
const h = createHarness(PORT, 'sub-channel-tag');

test.before(() => h.start());
test.after(() => h.stop());

test('a sub-channel takes its tag at creation', async (t) => {
  const admin = await h.register('admin');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const row = async (name) => {
    for (let i = 0; i < 30; i++) {
      const r = db.prepare('SELECT id, code, category FROM channels WHERE name = ?').get(name);
      if (r) return r;
      await wait(100);
    }
    throw new Error(`channel ${name} was not created`);
  };

  A.emit('create-channel', { name: 'hub' });
  const hub = await row('hub');

  A.emit('create-sub-channel', { parentCode: hub.code, name: 'first', category: '  Games  ' });
  assert.equal((await row('first')).category, 'Games');

  // Another casing of a tag already in use groups with it.
  A.emit('create-sub-channel', { parentCode: hub.code, name: 'second', category: 'games' });
  assert.equal((await row('second')).category, 'Games');

  // No tag, or a blank one, leaves it untagged.
  A.emit('create-sub-channel', { parentCode: hub.code, name: 'third', category: '   ' });
  assert.equal((await row('third')).category, null);
  A.emit('create-sub-channel', { parentCode: hub.code, name: 'fourth' });
  assert.equal((await row('fourth')).category, null);

  A.disconnect();
});

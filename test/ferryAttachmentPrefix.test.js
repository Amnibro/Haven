'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const FILES = ['app-messages.js', 'app-attachments.js', 'app-ferry.js'];
function loadApp(globals) {
  const methods = {};
  FILES.forEach(name => {
    const context = vm.createContext({ module: { exports: {} }, console, ...globals });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8').replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  });
  return methods;
}
function makeApp(value, { images = [], files = [], dm = null } = {}) {
  const input = { value, style: {}, focus() {}, dispatchEvent() {} };
  const emitted = [], images_ = [], files_ = [];
  const methods = loadApp({ document: { getElementById: id => (id === 'message-input' ? input : null), querySelector: () => null }, t: k => k, Event: class {} });
  const app = Object.assign(Object.create(null), methods, {
    currentChannel: 'aaaaaaaa',
    channels: [{ code: 'aaaaaaaa', is_dm: 0 }],
    socket: { connected: true, emit: (ev, data) => emitted.push([ev, data]) },
    notifications: { play() {} },
    user: { username: 'u' },
    _imageQueue: images,
    _fileQueue: files,
    _ferryDm: dm,
    _ferryTargets: { aaaaaaaa: { enabled: true, trigger: '=>', targets: [{ guild_name: 'Test Guild', discord_channel_name: 'general' }] } },
    _destructField: () => ({}),
    _highlightDefault: () => false,
    _setHighlightArmed() {},
    _clearReply() {},
    _hideMentionDropdown() {},
    _hideSlashDropdown() {},
    _clearImageQueue() { this._imageQueue = []; },
    _renderImageQueue() {},
    _isForumChannel: () => false,
    _dmSendGate: async () => ({ partner: null }),
    _uploadImage: async (file, code, bundled, prefix, spoiler, opts) => { images_.push({ bundled, prefix, opts }); },
    _uploadGeneralFile: (file, code, opts) => { files_.push(opts); },
  });
  return { app, emitted, images: images_, files: files_ };
}
const settle = () => new Promise(r => setTimeout(r, 20));
test('a picture sent with a Discord target carries the target', async () => {
  const { app, emitted, images } = makeApp('=>Test Guild#general look', { images: [{}] });
  await app._sendMessage();
  await settle();
  assert.deepEqual(emitted.map(([, d]) => d.content), ['=>Test Guild#general look']);
  assert.equal(images.length, 1);
  assert.equal(images[0].prefix, '=>Test Guild#general ');
  assert.equal(images[0].bundled, true);
});
test('a target with only attachments sends no empty text and still addresses them', async () => {
  const { app, emitted, images, files } = makeApp('=>#general', { images: [{}], files: [{}] });
  await app._sendMessage();
  await settle();
  assert.deepEqual(emitted, []);
  assert.equal(images[0].prefix, '=>#general ');
  assert.equal(images[0].bundled, false);
  assert.equal(files[0].prefix, '=>#general ');
});
test('a Discord DM target hands its user id to the attachments', async () => {
  const { app, emitted, images, files } = makeApp('=>@Alice hi', { images: [{}], files: [{}], dm: { id: '1300000000000000100', label: '@Alice' } });
  await app._sendMessage();
  await settle();
  assert.equal(emitted[0][1].ferryDiscordUserId, '1300000000000000100');
  assert.equal(images[0].prefix, '=>@Alice ');
  assert.equal(images[0].opts.ferryDiscordUserId, '1300000000000000100');
  assert.deepEqual({ ...files[0] }, { prefix: '=>@Alice ', ferryDiscordUserId: '1300000000000000100' });
});
test('an unknown target and plain text leave attachments as they were', async () => {
  for (const text of ['=>Nowhere#x hi', 'just text', '::Alter hello']) {
    const { app, images } = makeApp(text, { images: [{}] });
    await app._sendMessage();
    await settle();
    assert.equal(images[0].prefix, '', text);
  }
});

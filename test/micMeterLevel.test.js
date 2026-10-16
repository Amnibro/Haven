'use strict';

// The mic level meter in voice settings reads voice.currentMicLevel, which
// the noise gate loop sets from an analyser on the raw mic. It has to keep
// moving with noise reduction off, on the gate, and on AI suppression, and
// switching between them must never unhook the analyser. Before 4.22.0 the
// level was only worked out in gate mode, so the meter sat flat with noise
// reduction off (reported again from Haven Desktop).

const assert = require('node:assert/strict');
const test = require('node:test');

function fakeNode(name) {
  const node = {
    name,
    targets: new Set(),
    connect(target) { node.targets.add(target); return target; },
    disconnect(target) { if (target) node.targets.delete(target); else node.targets.clear(); },
  };
  return node;
}

function loadVoice() {
  const saved = {};
  global.localStorage = { getItem: () => null, setItem: (k, v) => { saved[k] = v; }, removeItem() {} };
  global.AudioWorkletNode = class {
    constructor() {
      Object.assign(this, fakeNode('rnnoise'));
      this.port = { postMessage() {}, onmessage: null, onmessageerror: null };
    }
  };
  delete require.cache[require.resolve('../public/js/voice.js')];
  const { VoiceManager } = require('../public/js/voice.js');
  const source = fakeNode('source');
  const analyser = Object.assign(fakeNode('analyser'), {
    frequencyBinCount: 8,
    level: 25,
    getByteFrequencyData(arr) { arr.fill(this.level); },
  });
  const gain = Object.assign(fakeNode('gain'), { gain: { value: 1, setTargetAtTime(v) { this.value = v; } } });
  source.connect(analyser);
  source.connect(gain);
  const voice = Object.assign(Object.create(VoiceManager.prototype), {
    audioCtx: { currentTime: 0, sampleRate: 48000 },
    inVoice: true,
    noiseMode: 'gate',
    noiseSensitivity: 10,
    currentMicLevel: 0,
    _noiseGateInterval: null,
    _noiseGateAnalyser: analyser,
    _noiseGateGain: gain,
    _rnnoiseSource: source,
    _rnnoiseNode: null,
    _rnnoiseReady: false,
    _rnnoiseWasmBytes: new ArrayBuffer(4096),
  });
  return { voice, source, analyser, gain };
}

test('the mic level follows the raw mic in every noise mode, and while switching', (t) => {
  const ticks = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn) => { ticks.push(fn); return ticks.length; };
  global.clearInterval = () => {};
  t.after(() => {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    delete global.localStorage;
    delete global.AudioWorkletNode;
  });

  const { voice, source, analyser } = loadVoice();
  voice._startNoiseGate();
  assert.equal(ticks.length, 1);
  const tick = ticks[0];

  for (const mode of ['off', 'suppress', 'off', 'gate', 'suppress', 'gate', 'off']) {
    voice.setNoiseMode(mode);
    voice.currentMicLevel = 0;
    analyser.level = 25;
    tick();
    assert.equal(voice.currentMicLevel, 50, `${mode}: the meter moves`);
    analyser.level = 0;
    tick();
    assert.equal(voice.currentMicLevel, 0, `${mode}: and falls back with silence`);
    assert.ok(source.targets.has(analyser), `${mode}: the analyser still hears the raw mic`);
    assert.equal(!!voice._rnnoiseNode, mode === 'suppress', `${mode}: AI suppression only in its own mode`);
  }
});

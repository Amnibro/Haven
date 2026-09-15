'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectInstallMethod, getUpdateInstructions } = require('../src/update-instructions');

test('git installs stay one-click', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-git-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'Install Haven.bat'), '');
  assert.equal(detectInstallMethod({ cwd: dir, platform: 'win32', inDocker: false }), 'git');
  const inst = getUpdateInstructions('git');
  assert.equal(inst.runnable, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('windows zip install is not runnable and does not invoke the bat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-zip-'));
  fs.writeFileSync(path.join(dir, 'Install Haven.bat'), '');
  assert.equal(detectInstallMethod({ cwd: dir, platform: 'win32', inDocker: false }), 'windows-installer');
  const inst = getUpdateInstructions('windows-installer');
  assert.equal(inst.runnable, false);
  assert.equal(/Install Haven\.bat/.test(inst.command), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shell zip install is not runnable and does not invoke install.sh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-sh-'));
  fs.writeFileSync(path.join(dir, 'install.sh'), '');
  assert.equal(detectInstallMethod({ cwd: dir, platform: 'linux', inDocker: false }), 'shell-installer');
  const inst = getUpdateInstructions('shell-installer');
  assert.equal(inst.runnable, false);
  assert.equal(/install\.sh/.test(inst.command), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('docker is never auto-run from inside the container', () => {
  const inst = getUpdateInstructions('docker');
  assert.equal(inst.runnable, false);
  assert.equal(detectInstallMethod({ cwd: os.tmpdir(), inDocker: true }), 'docker');
});

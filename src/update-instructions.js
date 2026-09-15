'use strict';

const fs = require('fs');
const path = require('path');

function detectInstallMethod(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const platform = opts.platform || process.platform;
  const inDocker = Object.prototype.hasOwnProperty.call(opts, 'inDocker')
    ? opts.inDocker
    : (fs.existsSync('/.dockerenv') || process.env.HAVEN_IN_DOCKER === 'true');
  if (inDocker) return 'docker';
  if (fs.existsSync(path.join(cwd, '.git'))) return 'git';
  if (platform === 'win32' && fs.existsSync(path.join(cwd, 'Install Haven.bat'))) return 'windows-installer';
  if (fs.existsSync(path.join(cwd, 'install.sh'))) return 'shell-installer';
  return 'manual';
}

function getUpdateInstructions(method) {
  switch (method) {
    case 'docker': return {
      runnable: false,
      command: 'docker compose pull && docker compose up -d',
      message: 'Update from the host machine: cd into the haven-docker folder and run the command below.',
    };
    case 'git': return {
      runnable: true,
      command: 'git pull --ff-only && npm install --omit=dev',
      message: 'Pull latest from GitHub and reinstall dependencies. The server will exit after the update so your supervisor (systemd / Docker / installer service) restarts it on the new code.',
    };
    case 'windows-installer': return {
      runnable: false,
      command: 'Download the latest release zip, unzip it over this folder, then restart Haven (or quit and relaunch Haven Desktop if it hosts the server).',
      message: 'Zip install. Do not run "Install Haven.bat" again: it is the first-time setup, not an updater. Your data stays in %APPDATA%\\Haven.',
    };
    case 'shell-installer': return {
      runnable: false,
      command: 'Download the latest release zip, unzip it over this folder, then restart Haven (or quit and relaunch Haven Desktop if it hosts the server).',
      message: 'Zip install. Do not run install.sh again: it is the first-time setup, not an updater. Your data stays in ~/.haven.',
    };
    default: return {
      runnable: false,
      message: 'Update method could not be detected. Pull the latest release from https://github.com/ancsemi/Haven/releases and replace your install manually.',
    };
  }
}

module.exports = { detectInstallMethod, getUpdateInstructions };

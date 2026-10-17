'use strict';

// The two outside programs Haven leans on for photos and videos: exiftool
// (reads and writes metadata) and ffmpeg (rewrites video files); see
// src/privacyPass.js for what they do.
//
// Both are optional. Without them photos are still cleaned by Haven's own
// code (src/imageMetadata.js: JPEG, PNG and WebP); with them, videos and
// every other photo format are cleaned too. The Docker image includes both.
//
// Each is looked for, in order, at the path in its environment variable, in
// the data folder's tools/, and on the PATH. Whichever answers its version
// check first is used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DATA_DIR } = require('./paths');

const TOOLS_DIR = path.join(DATA_DIR, 'tools');
const EXE = process.platform === 'win32' ? '.exe' : '';

const TOOLS = {
  exiftool: {
    env: 'HAVEN_EXIFTOOL_PATH',
    local: [path.join(TOOLS_DIR, 'exiftool', 'exiftool' + EXE)],
    name: 'exiftool',
    args: ['-ver'],
    version: (out) => (/^\d+\.\d+/.exec(out.trim()) || [])[0] || null,
  },
  ffmpeg: {
    env: 'HAVEN_FFMPEG_PATH',
    local: [path.join(TOOLS_DIR, 'ffmpeg', 'ffmpeg' + EXE)],
    name: 'ffmpeg',
    args: ['-hide_banner', '-version'],
    version: (out) => (/ffmpeg version (\S+)/.exec(out) || [])[1] || null,
  },
};

const found = { exiftool: null, ffmpeg: null };

function probe(tool, candidate) {
  try {
    const r = spawnSync(candidate, TOOLS[tool].args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const version = TOOLS[tool].version(r.stdout || '');
    return version ? { path: candidate, version } : null;
  } catch { return null; }
}

/** Look for both tools again. Returns true when both are usable. */
function locateTools() {
  for (const tool of Object.keys(TOOLS)) {
    const t = TOOLS[tool];
    const candidates = [process.env[t.env], ...t.local.filter(p => fs.existsSync(p)), t.name].filter(Boolean);
    found[tool] = null;
    for (const c of candidates) {
      const hit = probe(tool, c);
      if (hit) { found[tool] = hit; break; }
    }
  }
  return toolsReady();
}

function toolsReady() { return !!(found.exiftool && found.ffmpeg); }
function missingTools() { return Object.keys(found).filter(t => !found[t]); }
function toolPath(tool) { return found[tool]?.path || null; }
function toolInfo() { return { exiftool: found.exiftool?.version || null, ffmpeg: found.ffmpeg?.version || null }; }

// Photo and video work never gets ahead of chat and voice.
function lowerPriority(child) {
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not permitted here: runs at normal priority */ }
}

/**
 * Run a tool to completion. Resolves { code, stdout, stderr }; never rejects
 * on a non-zero exit, only when the program cannot be started at all.
 * `signal` stops it early, `onStdout` sees output as it arrives.
 */
function run(tool, args, { signal, onStdout, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!found[tool]) return reject(Object.assign(new Error(`${tool} is not installed`), { code: 'TOOL_MISSING' }));
    const child = spawn(found[tool].path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    lowerPriority(child);
    let stdout = '', stderr = '', settled = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < 4e6) stdout += d; onStdout?.(d); });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr, aborted: !!signal?.aborted })));
  });
}

// ── exiftool, kept running ───────────────────────────────
// Starting exiftool costs more than reading a photo does, so one copy stays
// open in its -stay_open mode and takes commands one at a time. Each command
// ends with a numbered marker on both outputs so replies cannot be mixed up.
let et = null;

function startExiftool() {
  const child = spawn(found.exiftool.path, ['-stay_open', 'True', '-@', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  lowerPriority(child);
  const state = { child, queue: [], current: null, out: '', err: '', seq: 0 };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const check = () => {
    const job = state.current;
    if (!job) return;
    const marker = `{ready${job.id}}`;
    const oi = state.out.indexOf(marker), ei = state.err.indexOf(marker);
    if (oi === -1 || ei === -1) return;
    const stdout = state.out.slice(0, oi), stderr = state.err.slice(0, ei);
    state.out = state.out.slice(oi + marker.length).replace(/^\r?\n/, '');
    state.err = state.err.slice(ei + marker.length).replace(/^\r?\n/, '');
    clearTimeout(job.timer);
    state.current = null;
    job.resolve({ stdout, stderr });
    next(state);
  };
  child.stdout.on('data', (d) => { state.out += d; check(); });
  child.stderr.on('data', (d) => { state.err += d; check(); });
  const fail = (err) => {
    if (et === state) et = null;
    const jobs = [state.current, ...state.queue].filter(Boolean);
    state.current = null; state.queue = [];
    for (const j of jobs) { clearTimeout(j.timer); j.reject(err); }
  };
  child.on('error', fail);
  child.on('close', () => fail(new Error('exiftool stopped unexpectedly')));
  child.stdin.on('error', () => { /* reported through close */ });
  return state;
}

function next(state) {
  if (state.current || !state.queue.length) return;
  const job = state.current = state.queue.shift();
  job.timer = setTimeout(() => {
    // A file that hangs exiftool takes the process with it; the next call
    // starts a fresh one.
    try { state.child.kill('SIGKILL'); } catch { /* already gone */ }
  }, job.timeoutMs);
  const lines = [...job.args, `-echo4`, `{ready${job.id}}`, `-execute${job.id}`];
  state.child.stdin.write(lines.join('\n') + '\n');
}

/** One exiftool command on the long-running copy. Resolves { stdout, stderr }. */
function exiftool(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!found.exiftool) return reject(Object.assign(new Error('exiftool is not installed'), { code: 'TOOL_MISSING' }));
    if (args.some(a => /[\r\n]/.test(a))) return reject(new Error('exiftool argument contains a line break'));
    if (!et) et = startExiftool();
    et.seq += 1;
    et.queue.push({ id: et.seq, args: ['-charset', 'filename=utf8', ...args], resolve, reject, timeoutMs });
    next(et);
  });
}

function stopExiftool() {
  if (!et) return;
  try { et.child.stdin.write('-stay_open\nFalse\n'); } catch { /* already gone */ }
  et = null;
}

module.exports = { TOOLS_DIR, locateTools, toolsReady, missingTools, toolInfo, toolPath, run, exiftool, stopExiftool };

#!/usr/bin/env node
'use strict';

/**
 * Start the dsh-pet standalone host when Codex starts.
 *
 * Normally started on demand: a scheduled task triggered by the AppModel event
 * Codex writes when it launches (event 201 in Microsoft-Windows-AppModel-Runtime/Admin)
 * runs start-watch.vbs, which starts this script with --exit-on-codex-close.
 * Nothing runs at logon. Polls for a Codex process and launches standalone mode
 * on the false -> true edge, or on the first poll if Codex is already running
 * and the pet is not.
 *
 * On purpose it does NOT resurrect the pet after the user quits it while Codex
 * stays open — only a fresh Codex launch does.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const {
  STATE_DIR,
  DSH_HOME,
  STANDALONE_RUNTIME: RUNTIME,
  LAUNCH_FILE,
  LAUNCH_VBS,
  LOG,
  STANDALONE_JS,
  STANDALONE_START,
  STANDALONE_PORT,
} = require('./config');

const POLL_MS = 5000;
const LAUNCH_COOLDOWN_MS = 60_000;
const STARTUP_GRACE_MS = 3 * 60_000;

function log(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
    if (fs.statSync(LOG).size > 200_000) fs.truncateSync(LOG, 0);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `codex.exe` covers the CLI/app-server; `ChatGPT.exe` is the desktop app.
 * Returns null when the process list cannot be read — "unknown" must not be
 * mistaken for "Codex closed", or a single failed tasklist call would stop the pet.
 */
function codexRunning() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return /^"(?:codex|chatgpt)\.exe"/im.test(out);
  } catch (err) {
    log('tasklist failed: ' + err.message);
    return null;
  }
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 800 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text).name === 'dsh-pet-standalone');
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Parsed runtime file, or null when it is missing / points at a dead process. */
function readRuntime() {
  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
  } catch {
    return null;
  }
  if (!runtime || !Number.isInteger(runtime.port)) return null;
  if (Number.isInteger(runtime.pid)) {
    try {
      process.kill(runtime.pid, 0);
    } catch (err) {
      if (err.code !== 'EPERM') return null;
    }
  }
  return runtime;
}

async function petAlive() {
  const runtime = readRuntime();
  if (!runtime) return false;
  return health(runtime.port);
}

/**
 * Ask the standalone pet to exit (POST /shutdown with its per-process token).
 * Graceful: the host stops the Electron helper itself, so no orphan windows.
 */
function shutdownPet(runtime) {
  return new Promise((resolve) => {
    const payload = '{}';
    const req = http.request(
      {
        host: '127.0.0.1',
        port: runtime.port,
        path: '/shutdown',
        method: 'POST',
        timeout: 2000,
        headers: {
          'x-dsh-pet-token': String(runtime.token || ''),
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('error', (err) => {
      log('shutdown request failed: ' + err.message);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      log('shutdown request timed out');
      resolve(false);
    });
    req.end(payload);
  });
}

/** Shared with hook.js: at most one launch per minute across all callers. */
function claimLaunch() {
  const now = Date.now();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ at: now }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
    }
    let last = 0;
    try {
      last = JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8')).at || 0;
    } catch {}
    if (now - last < LAUNCH_COOLDOWN_MS) return false;
    fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ at: now }));
    return true;
  } catch (err) {
    log('claimLaunch failed: ' + err.message);
    return false;
  }
}

function launchPet() {
  if (!fs.existsSync(STANDALONE_START) && !fs.existsSync(STANDALONE_JS)) {
    log('standalone entry not found: ' + STANDALONE_JS);
    return false;
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const starter = fs.existsSync(STANDALONE_START)
      ? `sh.Run """${process.execPath}"" ""${STANDALONE_START}""", 0, False`
      : `sh.Run """${process.execPath}"" ""${STANDALONE_JS}"" --port ${STANDALONE_PORT}", 0, False`;
    fs.writeFileSync(
      LAUNCH_VBS,
      [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Environment("PROCESS")("DSH_HOME") = "${DSH_HOME}"`,
        `sh.CurrentDirectory = "${path.dirname(STANDALONE_JS)}"`,
        starter,
        '',
      ].join('\r\n'),
    );
    // Explorer hands the launch to the shell, so the pet is not tied to this
    // watchdog's process tree (and survives a restart of it).
    const child = spawn('explorer.exe', [LAUNCH_VBS], { detached: true, stdio: 'ignore' });
    child.unref();
    log('launched standalone pet');
    return true;
  } catch (err) {
    log('launch failed: ' + err.message);
    return false;
  }
}

async function main() {
  const once = process.argv.includes('--once');
  // Event-driven mode: nothing will start a watchdog again until the next Codex
  // launch, so this one must not linger after its Codex is gone.
  const exitOnClose = process.argv.includes('--exit-on-codex-close');
  const startedAt = Date.now();
  log(`watchdog started (pid ${process.pid})${once ? ' [once]' : ''}`);
  let wasRunning = false;
  for (;;) {
    const running = codexRunning();
    if (running === true) {
      if (!(await petAlive())) {
        // First poll (Codex may have started before the watchdog) or a launch edge.
        if (!wasRunning && claimLaunch()) launchPet();
      }
    } else if (running === false && wasRunning) {
      // Codex closed -> the pet must not outlive it. Edge only: a pet started by
      // hand while Codex is closed stays untouched.
      const runtime = readRuntime();
      if (runtime && (await health(runtime.port))) {
        log('codex closed — shutting down pet');
        if (!(await shutdownPet(runtime))) log('pet is still running (shutdown failed)');
      }
      if (exitOnClose) {
        log('codex closed — watchdog exiting');
        process.exit(0);
      }
    }
    if (running !== null) wasRunning = running;
    if (once) {
      log(`once: codex=${running} pet=${await petAlive()}`);
      process.exit(0);
    }
    // A misfired trigger (e.g. Codex closed within one poll) must not leave a
    // watchdog running forever.
    if (exitOnClose && !wasRunning && Date.now() - startedAt > STARTUP_GRACE_MS) {
      log('codex never showed up — watchdog exiting');
      process.exit(0);
    }
    await sleep(POLL_MS);
  }
}

// Single instance: a second watchdog (Startup item launched twice, manual run)
// would only duplicate polling and could race the launch.
const LOCK_PORT = 37819;
const lock = net.createServer();
lock.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('another watchdog is already running; exiting');
    process.exit(0);
  }
  log('lock error: ' + err.message);
  main().catch((error) => {
    log('watchdog crashed: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
  });
});
lock.listen(LOCK_PORT, '127.0.0.1', () => {
  main().catch((err) => {
    log('watchdog crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
});

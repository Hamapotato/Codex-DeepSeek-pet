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
 * When Codex closes this watchdog writes that day's diary and then exits. The
 * pet itself is left running: it stays on the desktop until the user closes it.
 *
 * On purpose it does NOT resurrect the pet after the user quits it while Codex
 * stays open — only a fresh Codex launch does.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { runDiary, dayKey } = require('./diary');
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
  // 跨天：Codex 连续开着时，午夜过后把"昨天"的日记补上。
  let currentDay = dayKey();
  // 运行中：每 12 次轮询（≈60 秒）看一次"这一段是不是攒够一大段了"。
  let pollsSinceDiaryCheck = 0;
  for (;;) {
    const today = dayKey();
    if (today !== currentDay) {
      await diary(currentDay, 'date-rollover');
      currentDay = today;
    }
    const running = codexRunning();
    if (running === true) {
      if (!(await petAlive())) {
        // First poll (Codex may have started before the watchdog) or a launch edge.
        if (!wasRunning && claimLaunch()) launchPet();
      }
      // Codex 一直开着：攒够一大段就写一条，不等关闭。
      if (++pollsSinceDiaryCheck >= 12) {
        pollsSinceDiaryCheck = 0;
        await diary(today, 'midrun');
      }
    } else if (running === false && wasRunning) {
      // Codex closed -> write today's diary, then leave the pet alone: it stays
      // on the desktop until the user closes it by hand.
      await diary(today, 'codex-close');
      if (exitOnClose) {
        log('codex closed — pet left running, watchdog exiting');
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

/**
 * 写某天的日记。永远不抛错、最多占 45 秒——日记失败不能影响桌宠的启停。
 */
async function diary(date, reason) {
  try {
    // 跨天补写沿用"关闭"的门槛；运行中是更高的门槛。
    const mode = reason === 'midrun' ? 'midrun' : 'codex-close';
    const result = await Promise.race([
      runDiary({ date, reason: mode, quiet: true }),
      sleep(45_000).then(() => ({ status: 'timeout' })),
    ]);
    log(`diary ${date} (${reason}): ${result.status}${result.reason ? '/' + result.reason : ''}`);
  } catch (err) {
    log(`diary ${date} (${reason}) failed: ${err.message}`);
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

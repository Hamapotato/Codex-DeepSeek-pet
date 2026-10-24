#!/usr/bin/env node
'use strict';

/**
 * Codex lifecycle hook -> dsh-pet (DeepSeek Harness desktop pet)
 *
 * Codex invokes this with the event JSON on stdin. We translate the event into
 * a dsh-pet animation (and sometimes a bubble) over the plugin's local HTTP API.
 *
 * Two hosts are supported:
 *   1. standalone mode (`lib/standalone.js`) — a floating pet window, no DSH UI;
 *      writes need the per-process token from `<DSH_HOME>/dsh-pet/standalone-runtime.json`;
 *   2. the full DeepSeek Harness app hosting the plugin inline (no token).
 * If neither is running we start standalone in the background.
 *
 * API contract: https://github.com/PC2005-cloud/dsh-pet/blob/main/API.md
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const { isLinked, buildContext, recordTurn } = require('./chat-link');
const {
  ROUTE,
  STATE_DIR,
  PORT_CACHE,
  THROTTLE_FILE,
  LAUNCH_FILE,
  DEBUG_LOG,
  DSH_HOME,
  STANDALONE_RUNTIME,
  STANDALONE_JS,
  STANDALONE_START,
  STANDALONE_PORT,
  LAUNCH_VBS,
  NODE_EXE,
} = require('./config');

const DEBUG = !!process.env.DSH_PET_CODEX_DEBUG;

// ---------------------------------------------------------------------------
// Event -> pet behaviour
// ---------------------------------------------------------------------------

const ANIM = {
  thinking: '工作状态-思考冒泡',
  working: '工作状态-忙碌点按',
  waiting: '工作状态-原地踱步张望',
  success: '工作状态-雀跃庆祝',
  error: '工作状态-垂头叹气冒汗',
};

const THINKING_TEXTS = ['让我想想…', '收到，我先理一下思路~'];
const WAITING_TEXTS = ['需要你确认一下呢', '这里要等你看一下哦'];
const SUCCESS_TEXTS = ['这一轮搞定啦！', '任务完成咯，可以摸鱼啦~'];
const ERROR_TEXTS = ['哎呀，被打断了…', '这一步好像没跑通呢'];

// PostToolUse fires once per tool call; don't replay the same animation endlessly.
const WORKING_THROTTLE_MS = 8000;

// Fallback host only: standalone mode (below) is preferred, and this full DSH
// app is launched only when the standalone entry point is missing.
const DSH_EXE =
  process.env.DSH_PET_HOST_EXE || 'D:\\DeepSeek Harness\\dsh\\DeepSeek Harness.exe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Last event seen by the hook — cheap diagnostics for `--check` / troubleshooting. */
function note(record) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATE_DIR, 'last-event.json'),
      JSON.stringify({ at: new Date().toISOString(), ...record }),
    );
  } catch {}
}

function debug(...args) {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${args.join(' ')}\n`);
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    const done = () => resolve(raw);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // Codex always closes stdin, but never hang the agent if it does not.
    const timer = setTimeout(done, 1500);
    timer.unref();
  });
}

function httpJson(port, method, pathname, body, timeoutMs, token) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload
      ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) }
      : {};
    // Standalone mode authorizes every non-public request with a per-process
    // capability token (read from its runtime file). DSH's own plugin has none.
    if (token) headers['x-dsh-pet-token'] = token;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ports a local service is listening on, derived from netstat (locale independent). */
function listeningPorts() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      // Local address may be 0.0.0.0, 127.0.0.1, [::] or [::1]; listeners have
      // a wildcard foreign address (0.0.0.0:0 / [::]:0).
      const m = line.match(/^\s*TCP\s+\S*?:(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s/i);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch (err) {
    debug('netstat failed:', err.message);
    return [];
  }
}

async function probePort(port) {
  const res = await httpJson(port, 'GET', `${ROUTE}/config`, undefined, 400);
  if (!res || res.status !== 200 || !res.json || typeof res.json !== 'object') return null;
  // Config shape: { main: { pets: [...] }, <pack>: {...} }
  if (!res.json.main || !Array.isArray(res.json.main.pets)) return null;
  return res.json;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Standalone mode (no DSH): the runtime file is authoritative for port + token.
 * A leftover file from a crashed process is detected via the pid / health name.
 */
async function findStandalone() {
  let rt;
  try {
    rt = JSON.parse(fs.readFileSync(STANDALONE_RUNTIME, 'utf8'));
  } catch {
    return null;
  }
  if (!rt || !Number.isInteger(rt.port) || typeof rt.token !== 'string') return null;
  if (Number.isInteger(rt.pid) && !processAlive(rt.pid)) {
    debug('stale standalone runtime file, pid', rt.pid, 'is gone');
    return null;
  }
  const health = await httpJson(rt.port, 'GET', '/health', undefined, 400);
  if (!health || health.status !== 200 || !health.json || health.json.name !== 'dsh-pet-standalone') {
    return null;
  }
  const cfg = await httpJson(rt.port, 'GET', `${ROUTE}/config`, undefined, 800);
  if (!cfg || cfg.status !== 200 || !cfg.json || !cfg.json.main) return null;
  return { mode: 'standalone', port: rt.port, token: rt.token, cfg: cfg.json };
}

async function discover() {
  // 1) Standalone first: it is the lighter host and the one we auto-launch.
  const standalone = await findStandalone();
  if (standalone) return standalone;

  // 2) DSH-hosted plugin: try the cached port first — a warm hit costs ~2ms.
  try {
    const cached = JSON.parse(fs.readFileSync(PORT_CACHE, 'utf8'));
    if (cached && Number.isInteger(cached.port)) {
      const cfg = await probePort(cached.port);
      if (cfg) return { port: cached.port, cfg };
    }
  } catch {}

  // 3) Scan every local listening port once.
  const ports = listeningPorts();
  ports.sort((a, b) => (a === 3080 ? -1 : b === 3080 ? 1 : b - a)); // standalone default first
  let found = null;
  const queue = ports.slice();
  const workers = Array.from({ length: 24 }, async () => {
    while (!found && queue.length) {
      const port = queue.shift();
      const cfg = await probePort(port);
      if (cfg && !found) found = { port, cfg };
    }
  });
  await Promise.all(workers);

  if (found) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(PORT_CACHE, JSON.stringify({ port: found.port, at: Date.now() }));
    } catch {}
    debug('discovered DSH on port', found.port);
  }
  return found && { mode: 'dsh', port: found.port, token: null, cfg: found.cfg };
}

function pickPet(cfg) {
  if (process.env.DSH_PET_ID) return process.env.DSH_PET_ID;
  const entries = Object.values(cfg || {});
  const pets = [];
  for (const entry of entries) {
    if (entry && Array.isArray(entry.pets)) pets.push(...entry.pets);
  }
  const usable = pets.find((p) => p && p.id && p.display !== 'none');
  return usable ? String(usable.id) : pets[0] && pets[0].id ? String(pets[0].id) : 'main';
}

function throttled(sessionId) {
  const now = Date.now();
  let state = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') state = parsed;
  } catch {
    // Missing or corrupt throttle file: treat as "never fired".
  }
  // Keep the file from growing across sessions.
  for (const key of Object.keys(state)) {
    if (typeof state[key] !== 'number' || now - state[key] > 3600_000) delete state[key];
  }
  if (state[sessionId] && now - state[sessionId] < WORKING_THROTTLE_MS) return true;
  state[sessionId] = now;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(THROTTLE_FILE, JSON.stringify(state));
  } catch {}
  return false;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Start the pet host without blocking Codex. Launches are throttled to one per
 * minute — otherwise every hook of a cold turn would spawn another instance.
 * The throttle file is shared with watch-codex.js.
 */
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
    if (now - last < 60_000) return false;
    fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ at: now }));
    return true;
  } catch (err) {
    debug('claimLaunch failed:', err.message);
    return false;
  }
}

function ensureHost() {
  if (!claimLaunch()) return;

  // Preferred: standalone mode — only the floating pet window, no DSH UI.
  // Explorer cannot start node directly, hence the generated hidden VBScript.
  if (fs.existsSync(STANDALONE_START) || fs.existsSync(STANDALONE_JS)) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const starter = fs.existsSync(STANDALONE_START)
        ? `sh.Run """${NODE_EXE}"" ""${STANDALONE_START}""", 0, False`
        : `sh.Run """${NODE_EXE}"" ""${STANDALONE_JS}"" --port ${STANDALONE_PORT}", 0, False`;
      const script = [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Environment("PROCESS")("DSH_HOME") = "${DSH_HOME}"`,
        `sh.CurrentDirectory = "${path.dirname(STANDALONE_JS)}"`,
        starter,
        '',
      ].join('\r\n');
      fs.writeFileSync(LAUNCH_VBS, script);
      // Same reason as below: go through Explorer so DSH/Codex's job cannot kill it.
      const child = spawn('explorer.exe', [LAUNCH_VBS], { detached: true, stdio: 'ignore' });
      child.unref();
      debug('launched standalone via explorer:', STANDALONE_JS);
      return;
    } catch (err) {
      debug('failed to launch standalone:', err.message);
    }
  }

  // Fallback: the full DSH app, which hosts the same plugin inline.
  try {
    if (!fs.existsSync(DSH_EXE)) {
      debug('DSH executable not found:', DSH_EXE);
      return;
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Codex runs hooks inside its process tree/job, and a directly spawned DSH
    // gets killed when the hook (or Codex) exits. Explorer hands the launch to
    // the shell, so the app outlives Codex.
    const child = spawn('explorer.exe', [DSH_EXE], { detached: true, stdio: 'ignore' });
    child.unref();
    debug('launched DSH via explorer:', DSH_EXE);
  } catch (err) {
    debug('failed to launch DSH:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function plan(input) {
  const event = String(input.hook_event_name || '');
  switch (event) {
    case 'UserPromptSubmit':
      return { anim: ANIM.thinking, text: pick(THINKING_TEXTS) };
    case 'PostToolUse':
      return { anim: ANIM.working, text: null, throttle: true };
    case 'PermissionRequest':
      return { anim: ANIM.waiting, text: pick(WAITING_TEXTS) };
    case 'Stop':
      if (input.stop_hook_active) return null; // never re-trigger while stopping
      return { anim: ANIM.success, text: pick(SUCCESS_TEXTS) };
    case 'Interrupt':
      return { anim: ANIM.error, text: pick(ERROR_TEXTS) };
    default:
      return null; // SessionStart / SessionEnd / PreCompact / ... : stay quiet
  }
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { debug('bad stdin:', raw.slice(0, 200)); return; }

  const event = String(input.hook_event_name || '');
  const sessionId = String(input.session_id || '');
  note({ event, sessionId, phase: 'received' });

  // ---- 心声线：被绑定的那条对话和桌宠双向同步 ----
  if (sessionId && isLinked(sessionId)) {
    if (event === 'UserPromptSubmit') {
      // 把「人设 + 日记 + 印象 + 共同记忆」注入这一轮，让模型以桌宠身份说话
      try {
        const context = buildContext(sessionId);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
          }) + '\n',
        );
      } catch (err) {
        debug('chat-link context failed:', err.message);
      }
    } else if (event === 'Stop') {
      // 一轮结束：把这一问一答写进共享记忆
      try {
        const { added } = recordTurn(input.transcript_path);
        if (added) debug(`chat-link memory +${added}`);
      } catch (err) {
        debug('chat-link record failed:', err.message);
      }
    }
  }
  const action = plan(input);

  // SessionStart has no animation of its own; it only makes sure the host is up.
  if (!action && event !== 'SessionStart') return;

  if (action && action.throttle) {
    const sessionId = String(input.session_id || 'unknown');
    if (throttled(sessionId)) { debug('throttled working animation'); return; }
  }

  const found = await discover();
  if (!found) {
    note({ event, phase: 'host-missing' });
    // Not just SessionStart: `codex exec` does not emit SessionStart at all, and
    // DSH may also have been closed mid-session.
    if (event !== 'SessionEnd') {
      debug('dsh-pet not reachable — launching host (standalone preferred)');
      ensureHost();
    }
    return;
  }

  note({ event, phase: 'host-found', mode: found.mode, port: found.port });

  if (!action) return; // SessionStart with the host already running

  const pet = pickPet(found.cfg);
  const q = (extra = '') => `/dsh-pet-7340/${extra}`;
  const base = `pet=${encodeURIComponent(pet)}&surface=any`;

  // Acquire the pet so the user's own idle/whisper/status playback yields to us.
  const lockRes = await httpJson(found.port, 'POST', q(`lock?${base}`), { ttl: 20000 }, 800, found.token);
  if (!lockRes || !lockRes.json || lockRes.json.ok !== true || !lockRes.json.lockId) {
    debug('lock failed:', lockRes && lockRes.text);
    return;
  }
  const lockId = lockRes.json.lockId;

  try {
    if (action.anim) {
      const animRes = await httpJson(
        found.port,
        'POST',
        q(`anim?${base}&lock=${encodeURIComponent(lockId)}`),
        { name: action.anim },
        1200,
        found.token,
      );
      if (!animRes || !animRes.json || animRes.json.ok !== true) {
        debug('anim failed:', action.anim, animRes && animRes.text);
      }
    }
    if (action.text) {
      const sayRes = await httpJson(
        found.port,
        'POST',
        q(`broadcast?${base}&lock=${encodeURIComponent(lockId)}`),
        { text: action.text, duration: 6000, anim: false },
        1200,
        found.token,
      );
      if (!sayRes || !sayRes.json || sayRes.json.ok !== true) {
        debug('broadcast failed:', sayRes && sayRes.text);
      }
    }
  } finally {
    await httpJson(
      found.port,
      'POST',
      q(`lock/release?pet=${encodeURIComponent(pet)}`),
      { lockId },
      800,
      found.token,
    );
  }

  // A finished turn is exactly when token usage (and the balance) changed: refresh
  // now so the bubble updates within ~1s instead of waiting for the 30s poll.
  // Bounded: a slow upstream must not eat the Stop hook's time budget.
  if (event === 'Stop') {
    await httpJson(found.port, 'POST', q(`balance?${base}`), {}, 1200, found.token);
  }
}

if (process.argv.includes('--check')) {
  discover().then(
    (found) => {
      if (found) {
        console.log(
          `dsh-pet OK (${found.mode}) · 127.0.0.1:${found.port} · pet=${pickPet(found.cfg)}`,
        );
      } else {
        console.log('dsh-pet not found — 请先启动 DeepSeek Harness');
      }
      process.exit(0);
    },
    () => process.exit(1),
  );
} else {
  main().then(
    () => process.exit(0),
    (err) => { debug('unexpected:', err && err.stack); process.exit(0); },
  );
}

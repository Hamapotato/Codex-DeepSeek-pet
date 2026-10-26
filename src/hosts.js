'use strict';

/**
 * 找到"任意一个"正在跑的桌宠宿主。
 *
 * 有两种：
 *   1. standalone —— 我们自己的 node 进程，端口在 standalone-runtime.json 里；
 *   2. DSH 内置插件 —— DeepSeek Harness 跑起来时自己带的，端口随机。
 *
 * 之前看门狗只认第 1 种，所以 Codex 和 DSH 同时开时会再拉起一个 standalone，
 * 桌面上就出现两只宠物。这里统一判断：只要任意一种活着，就不再启动。
 */

const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

const { STANDALONE_RUNTIME, ROUTE, PORT_CACHE } = require('./config');

let dshCache = { port: null, at: 0 }; // 60 秒内不必重新扫端口
const DSH_CACHE_TTL = 60_000;

function httpJson(port, method, pathname, timeoutMs = 600, token) {
  return new Promise((resolve) => {
    const headers = token ? { 'x-dsh-pet-token': token } : {};
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function listeningPorts() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S*?:(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s/i);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    return [];
  }
}

async function probe(port) {
  const res = await httpJson(port, 'GET', `${ROUTE}/config`, 500);
  if (!res || res.status !== 200 || !res.json || !res.json.main || !Array.isArray(res.json.main.pets)) return null;
  return res.json;
}

/** 这个端口是不是我们自己的 standalone（不是 DSH）。 */
async function isStandalonePort(port) {
  try {
    const rt = JSON.parse(fs.readFileSync(STANDALONE_RUNTIME, 'utf8'));
    if (rt && rt.port === port && Number.isInteger(rt.pid) && processAlive(rt.pid)) return true;
  } catch {}
  const health = await httpJson(port, 'GET', '/health', 400);
  return Boolean(health && health.json && health.json.name === 'dsh-pet-standalone');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** 独立模式（我们自己的进程）。 */
async function findStandalone() {
  let rt;
  try {
    rt = JSON.parse(fs.readFileSync(STANDALONE_RUNTIME, 'utf8'));
  } catch {
    return null;
  }
  if (!rt || !Number.isInteger(rt.port)) return null;
  if (Number.isInteger(rt.pid) && !processAlive(rt.pid)) return null;
  const health = await httpJson(rt.port, 'GET', '/health', 500);
  if (!health || health.status !== 200 || !health.json || health.json.name !== 'dsh-pet-standalone') return null;
  return { mode: 'standalone', port: rt.port, token: rt.token || null, pid: rt.pid };
}

/** DSH 内置插件（随机端口）。 */
async function findDsh() {
  if (dshCache.port && Date.now() - dshCache.at < DSH_CACHE_TTL) {
    const cfg = (await isStandalonePort(dshCache.port)) ? null : await probe(dshCache.port);
    if (cfg) return { mode: 'dsh', port: dshCache.port, token: null, cfg };
    dshCache = { port: null, at: 0 };
  }

  try {
    const cached = JSON.parse(fs.readFileSync(PORT_CACHE, 'utf8'));
    if (cached && Number.isInteger(cached.port)) {
      const cfg = (await isStandalonePort(cached.port)) ? null : await probe(cached.port);
      if (cfg) {
        dshCache = { port: cached.port, at: Date.now() };
        return { mode: 'dsh', port: cached.port, token: null, cfg };
      }
    }
  } catch {}

  const ports = listeningPorts().filter((p) => p !== 3080);
  let found = null;
  const queue = ports.slice();
  const workers = Array.from({ length: 16 }, async () => {
    while (!found && queue.length) {
      const port = queue.shift();
      const cfg = await probe(port);
      if (cfg && !found) found = { port, cfg };
    }
  });
  await Promise.all(workers);

  if (found) {
    dshCache = { port: found.port, at: Date.now() };
    try {
      fs.mkdirSync(require('path').dirname(PORT_CACHE), { recursive: true });
      fs.writeFileSync(PORT_CACHE, JSON.stringify({ port: found.port, at: Date.now() }));
    } catch {}
    return { mode: 'dsh', port: found.port, token: null, cfg: found.cfg };
  }
  return null;
}

/** 任意一个宿主；优先 standalone（更轻，也是我们自动拉起的那个）。 */
async function findAnyHost() {
  const standalone = await findStandalone();
  if (standalone) return standalone;

  // DSH 可能只是 `dsh web`（没有桌面小窗）。只有它真的挂着桌面 Helper 才算"已有桌宠"，
  // 否则启动器仍然应该拉起 standalone，不然用户会一只宠物都看不到。
  const dsh = await findDsh();
  if (dsh && hasVisiblePetWindow()) return dsh;
  return null;
}

/**
 * 屏幕上是否已经有一只**可见的**桌宠窗口。
 *
 * DSH 可能只是 `dsh web`：进程和 Electron Helper 都在，但没有桌面小窗。
 * 这时候不能算"已有桌宠"，否则就不会拉起 standalone，用户一只也看不到。
 */
function hasVisiblePetWindow() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*桌宠*' } | Measure-Object).Count",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    ).trim();
    return Number(out) > 0;
  } catch {
    return false;
  }
}

module.exports = { findAnyHost, findStandalone, findDsh, hasVisiblePetWindow, httpJson };

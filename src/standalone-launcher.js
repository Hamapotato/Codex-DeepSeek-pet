#!/usr/bin/env node
'use strict';

/**
 * Hidden starter used by the generated VBScript (hook.js / watch-codex.js).
 * Rebuilds the patched standalone bundle when needed, then starts it.
 * Falls back to the stock bundle if the patched one cannot stay up.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const {
  PATCHED_JS: PATCHED,
  STOCK_JS: STOCK,
  STANDALONE_PORT: PORT,
  DSH_HOME,
} = require('./config');

const BUILDER = path.join(__dirname, 'patches', 'index.js');

function start(target) {
  const child = spawn(process.execPath, [target, '--port', String(PORT)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(target),
    env: { ...process.env, DSH_HOME },
  });
  child.unref();
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  try {
    if (fs.existsSync(BUILDER)) {
      execFileSync(process.execPath, [BUILDER], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 30000,
      });
    }
  } catch {}

  const target = fs.existsSync(PATCHED) ? PATCHED : STOCK;
  if (!fs.existsSync(target)) {
    console.error('dsh-pet standalone bundle not found: ' + target);
    process.exit(1);
  }

  const child = start(target);
  await sleep(2000);
  // The patched bundle exits during startup only if it is broken; fall back once.
  if (target === PATCHED && child.exitCode !== null && child.exitCode !== 0) {
    start(STOCK);
  }
  process.exit(0);
})();

#!/usr/bin/env node
'use strict';

/**
 * dsh-pet in-place patches — entry point.
 *
 * dsh-pet is installed as a node_modules package and gets overwritten on every
 * upgrade, so nothing is edited by hand: each patcher below rewrites the
 * installed copy, keeps a `*.dsh-pet-*` backup, is guarded by a marker comment
 * (idempotent) and is syntax-checked (a broken result is restored).
 *
 *   balance.js   standalone bundle + 余额气泡（常驻、格式化、颜色）
 *   menu.js      右键菜单分组 + 「查看日记」入口
 *   openpath.js  preload/main 的 pet:open-path 通道（打开本地文件）
 *   name.js      托盘提示改叫「大肥鱼」
 *
 * Run manually: `npm run build` (or `--force` to rebuild the standalone bundle).
 * src/standalone-launcher.js runs this before every pet launch.
 */

const { CONSTANTS, EVENTS, patchHelper } = require('./shared');
const {
  buildStandalone,
  patchConstants,
  patchEvents,
  patchStartupBalance,
  patchBalanceRows,
  patchIndexHtml,
} = require('./balance');
const { patchMenu } = require('./menu');
const { patchPreloadOpenPath, patchMainOpenPath } = require('./openpath');
const { patchPetName } = require('./name');

const force = process.argv.includes('--force');

const results = [
  buildStandalone(force),
  patchHelper(CONSTANTS, patchConstants),
  patchHelper(EVENTS, patchEvents),
  patchStartupBalance(),
  patchBalanceRows(),
  patchIndexHtml(),
  patchPreloadOpenPath(),
  patchMainOpenPath(),
  patchMenu(),
  patchPetName(),
];

process.exitCode = results.every(Boolean) ? 0 : 1;

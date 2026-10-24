'use strict';

const fs = require('fs');
const { MAIN_JS, PRELOAD, OPEN_PATH_MARK, syntaxOk } = require('./shared');

function patchPreloadOpenPath() {
  if (!fs.existsSync(PRELOAD)) {
    console.error(`helper file not found: ${PRELOAD}`);
    return false;
  }
  const original = fs.readFileSync(PRELOAD, 'utf8');
  if (original.includes(OPEN_PATH_MARK)) {
    console.log('preload.js open-path patch already applied');
    return true;
  }
  const anchor = [
    '  openDshSite(url) {',
    "    ipcRenderer.send('pet:open-site', { url });",
    '  },',
  ].join('\n');
  if (!original.includes(anchor)) {
    console.error('preload.js: openDshSite anchor not found (dsh-pet changed?)');
    return false;
  }
  const addition = [
    '',
    '  // patched: 打开本地文件（右键菜单「查看日记」用；pet:open-site 只放行 http(s)）',
    '  openLocalFile(target) {',
    "    ipcRenderer.send('pet:open-path', { path: String(target) });",
    '  },',
  ].join('\n');
  const updated = original.replace(anchor, anchor + addition);
  const backup = `${PRELOAD}.dsh-pet-pre-openpath`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(PRELOAD, `${updated}\n${OPEN_PATH_MARK}\n`);
  if (!syntaxOk(PRELOAD)) {
    fs.writeFileSync(PRELOAD, original);
    console.error('preload.js: open-path patch failed syntax check, restored');
    return false;
  }
  const check = fs.readFileSync(PRELOAD, 'utf8');
  if (!check.includes('openLocalFile') || !check.includes("'pet:open-path'")) {
    fs.writeFileSync(PRELOAD, original);
    console.error('preload.js: open-path patch failed verification, restored');
    return false;
  }
  console.log('patched preload.js (openLocalFile)');
  return true;
}

/** main.js — handle `pet:open-path` with shell.openPath (works for local files). */

function patchMainOpenPath() {
  if (!fs.existsSync(MAIN_JS)) {
    console.error(`helper file not found: ${MAIN_JS}`);
    return false;
  }
  const original = fs.readFileSync(MAIN_JS, 'utf8');
  if (original.includes(OPEN_PATH_MARK)) {
    console.log('main.js open-path patch already applied');
    return true;
  }
  const anchor = "  ipcMain.on('pet:open-site', (event, payload) => {";
  if (!original.includes(anchor)) {
    console.error('main.js: pet:open-site anchor not found (dsh-pet changed?)');
    return false;
  }
  const block = [
    '  // patched: 用系统默认程序打开本地文件（右键菜单「查看日记」）',
    "  ipcMain.on('pet:open-path', (event, payload) => {",
    "    const target = payload && typeof payload === 'object' ? String(payload.path || '') : '';",
    '    if (!target) return;',
    '    shell.openPath(target).then((error) => {',
    "      if (error) console.error('[dsh-pet-desktop-helper] openPath failed:', error);",
    '    });',
    '  });',
    '',
    anchor,
  ].join('\n');
  const updated = original.replace(anchor, block);
  const backup = `${MAIN_JS}.dsh-pet-pre-openpath`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(MAIN_JS, `${updated}\n${OPEN_PATH_MARK}\n`);
  if (!syntaxOk(MAIN_JS)) {
    fs.writeFileSync(MAIN_JS, original);
    console.error('main.js: open-path patch failed syntax check, restored');
    return false;
  }
  const check = fs.readFileSync(MAIN_JS, 'utf8');
  if (!check.includes("ipcMain.on('pet:open-path'") || !check.includes('shell.openPath(target)')) {
    fs.writeFileSync(MAIN_JS, original);
    console.error('main.js: open-path patch failed verification, restored');
    return false;
  }
  console.log('patched main.js (pet:open-path)');
  return true;
}

module.exports = { patchPreloadOpenPath, patchMainOpenPath };

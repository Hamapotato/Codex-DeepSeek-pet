'use strict';

const fs = require('fs');
const { SPRITE, MENU_MARK, DIARY_MENU_MARK, DIARY_VIEWER_JS, DIARY_VIEWER_URL, syntaxOk } = require('./shared');

function patchMenu() {
  if (!fs.existsSync(SPRITE)) {
    console.error(`helper file not found: ${SPRITE}`);
    return false;
  }
  const original = fs.readFileSync(SPRITE, 'utf8');
  let text = original;

  // ---- 1) stock menu → grouped menu -------------------------------------
  if (!text.includes(MENU_MARK)) {
    const head = '    // 桌面专属工具根项（打开网站 / 查看余额 / 碎碎念 / 对话 / 回到初始位置 / 重载配置）';
    const tail = '    // 第三方菜单项统一收在「更多」下';
    const treeStock =
      '    const tree = tools.concat(S.buildMenuTree(this.animations), more ? [more] : []);';
    const treePatched =
      '    const tree = tools.concat(S.buildMenuTree(this.animations), toolMenu, more ? [more] : []);';
    const start = text.indexOf(head);
    const end = text.indexOf(tail, start);
    if (start < 0 || end < 0 || (!text.includes(treeStock) && !text.includes(treePatched))) {
      console.error('sprite.js: context-menu anchors not found (dsh-pet changed?)');
      return false;
    }
    const block = [
      '    // patched: 一级只留常用互动项；打开网站/显示位置/回到初始位置/重载配置收进「工具」',
      '    const tools = [',
      "      { label: '查看余额', action: 'show-balance' },",
      "      { label: '碎碎念', action: 'whisper' },",
      "      { label: '对话', action: 'chat' },",
      '    ];',
      '    const toolMenu = {',
      "      label: '工具',",
      '      children: [',
      '        {',
      "          label: OPEN_TARGET === 'desktop' ? '打开软件' : '打开网站',",
      "          action: 'open-site',",
      '          hint: OPEN_SHORTCUT_HINT,',
      '        },',
      '        S.displayMenuBranch(),',
      "        { label: '回到初始位置', action: 'home' },",
      "        { label: '重载配置', action: 'reload' },",
      '      ],',
      '    };',
      '',
    ].join('\n');
    text = text.slice(0, start) + block + text.slice(end);
    text = text.replace(treeStock, treePatched);
    text = `${text}\n${MENU_MARK}\n`;
  }

  // ---- 2) 「查看日记」菜单项 + 点击处理（可重复执行，也能升级旧补丁）--------
  {
    const chatLine = "      { label: '对话', action: 'chat' },";
    const openSiteAnchor = "    if (leaf.action === 'open-site') {";
    if (!text.includes(chatLine) || !text.includes(openSiteAnchor)) {
      console.error('sprite.js: diary menu anchors not found (dsh-pet changed?)');
      return false;
    }
    if (!text.includes("label: '查看日记'")) {
      text = text.replace(chatLine, `${chatLine}\n      { label: '查看日记', action: 'open-diary' },`);
    }

    // 旧版用 openDshSite(file://…)，但 pet:open-site 只放行 http(s)，file:// 会被静默丢弃。
    const oldHandler = [
      "    if (leaf.action === 'open-diary') {",
      '      // patched: 打开本地日记阅读页（系统默认浏览器）',
      `      if (window.petBridge) window.petBridge.openDshSite('${DIARY_VIEWER_URL}');`,
      '      return;',
      '    }',
    ].join('\n');
    const newHandler = [
      "    if (leaf.action === 'open-diary') {",
      '      // patched: 用系统默认程序打开本地日记阅读页（shell.openPath）',
      `      if (window.petBridge && window.petBridge.openLocalFile) window.petBridge.openLocalFile('${DIARY_VIEWER_JS}');`,
      '      return;',
      '    }',
    ].join('\n');

    if (text.includes(oldHandler)) {
      text = text.replace(oldHandler, newHandler);
    } else if (!text.includes("leaf.action === 'open-diary'")) {
      text = text.replace(openSiteAnchor, `${newHandler}\n${openSiteAnchor}`);
    }
    if (!text.includes(DIARY_MENU_MARK)) text = `${text}\n${DIARY_MENU_MARK}\n`;
  }

  if (text === original) {
    console.log('sprite.js menu patch already applied');
    return true;
  }

  const backup = `${SPRITE}.dsh-pet-pre-menu`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(SPRITE, text);
  if (!syntaxOk(SPRITE)) {
    fs.writeFileSync(SPRITE, original);
    console.error('sprite.js: menu patch failed syntax check, restored');
    return false;
  }
  const check = fs.readFileSync(SPRITE, 'utf8');
  const ok =
    (check.match(/label: '工具'/g) || []).length === 1 &&
    check.includes('toolMenu, more ?') &&
    check.includes("label: '查看日记'") &&
    check.includes("leaf.action === 'open-diary'");
  if (!ok) {
    fs.writeFileSync(SPRITE, original);
    console.error('sprite.js: menu patch failed verification, restored');
    return false;
  }
  console.log('patched sprite.js (context menu)');
  return true;
}

/**
 * The tray tooltip is the only place the program calls itself by name; show the
 * pet's name there too (taskbar / app.setName stay untouched on purpose: the
 * latter decides Electron's userData directory, so renaming it would orphan the
 * helper's Chromium profile and DPI cache).
 */

module.exports = { patchMenu };

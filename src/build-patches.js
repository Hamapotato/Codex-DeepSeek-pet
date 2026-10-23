#!/usr/bin/env node
'use strict';

/**
 * Local dsh-pet patches, applied in place to the installed package:
 *
 * 1. lib/standalone-codex.js — generated from the stock standalone bundle:
 *    - balance provider forced to the built-in `deepseek-official` route;
 *    - DEEPSEEK_API_KEY resolved locally (env → balance-key.txt → Codex config).
 *    The stock bundle itself stays untouched.
 *
 * 2. runtime/electron-helper/{constants,events}.js — balance visibility:
 *    - auto refresh of a `money` balance also shows the bubble (stock only shows
 *      it for percentage data, so DeepSeek money never appeared automatically);
 *    - the balance bubble stays up for 24h instead of 10s;
 *    - the first /state pull renders the balance already in the host state, so
 *      the bubble is there the moment the pet launches.
 *
 * 3. runtime/electron-helper/shared-core.js — bubble format:
 *    - `余额：¥x.xx（峰/谷）`；金额与档位括号着色（平时绿、峰时金）。
 *
 * 4. runtime/electron-helper/index.html — bubble CSS (scale 0.85, tier colors,
 *    no flex gap between label and amount).
 *
 * 5. runtime/electron-helper/sprite.js — context menu:
 *    - everyday actions on the first level, maintenance items under 「工具」.
 *
 * 6. runtime/electron-helper/main.js — tray tooltip shows the pet name (大肥鱼).
 *
 * Every in-place patch keeps an original (`*.dsh-pet-*`), is syntax-gated and
 * restores itself if the result does not parse. Re-run after upgrading dsh-pet
 * (src/standalone-launcher.js does this on every launch).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PKG, STOCK_JS: SRC, PATCHED_JS: OUT } = require('./config');

const HELPER = path.join(PKG, 'runtime', 'electron-helper');
const CONSTANTS = path.join(HELPER, 'constants.js');
const EVENTS = path.join(HELPER, 'events.js');
const SHARED = path.join(HELPER, 'shared-core.js');
const SPRITE = path.join(HELPER, 'sprite.js');
const MAIN_JS = path.join(HELPER, 'main.js');
const INDEX_HTML = path.join(HELPER, 'index.html');
const MARK = '/* dsh-pet standalone balance patch */';
const HELPER_MARK = '/* dsh-pet balance visibility patch */';
const STARTUP_MARK = '/* dsh-pet startup balance patch */';
const ROWS_MARK = '/* dsh-pet balance row patch */';
const MENU_MARK = '/* dsh-pet menu patch v2 */';
const NAME_MARK = '/* dsh-pet name patch */';
const PET_NAME = '大肥鱼';
const BALANCE_HOLD_MS = 24 * 60 * 60 * 1000;
// Balance bubble scale (1 = stock). The money bubble is the only plain
// `.pet-bubble`; whisper/work bubbles carry `.is-whisper`, so they are untouched.
const BALANCE_BUBBLE_SCALE = (() => {
  const raw = Number(process.env.DSH_PET_BALANCE_BUBBLE_SCALE);
  return Number.isFinite(raw) && raw >= 0.4 && raw <= 1.5 ? raw : 0.85;
})();

const PREAMBLE = `${MARK}
function __petBalanceKey() {
\ttry {
\t\tconst env = process.env.DEEPSEEK_API_KEY || process.env.DSH_PET_BALANCE_KEY;
\t\tif (env && env.trim()) return env.trim();
\t} catch {}
\ttry {
\t\tconst file = join(process.env.LOCALAPPDATA || homedir(), "dsh-pet-codex", "balance-key.txt");
\t\tconst value = readFileSync(file, "utf8").trim();
\t\tif (value) return value;
\t} catch {}
\ttry {
\t\tconst text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
\t\tconst match = text.match(/experimental_bearer_token\\s*=\\s*"([^"]+)"/) ||
\t\t\ttext.match(/ANTHROPIC_AUTH_TOKEN\\s*=\\s*"([^"]+)"/);
\t\tif (match) return match[1];
\t} catch {}
\treturn undefined;
}
function __petBalanceProvider(provider) {
\treturn process.env.DSH_PET_BALANCE_PROVIDER || "deepseek-official";
}
async function __petBalanceCredential(ref) {
\tif (String(ref) !== "DEEPSEEK_API_KEY") return undefined;
\tconst key = __petBalanceKey();
\treturn key ? { value: key } : undefined;
}
`;

function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function buildStandalone(force) {
  if (!fs.existsSync(SRC)) {
    console.error(`dsh-pet standalone bundle not found: ${SRC}`);
    return false;
  }
  const srcStat = fs.statSync(SRC);
  if (!force && fs.existsSync(OUT)) {
    const outStat = fs.statSync(OUT);
    if (outStat.mtimeMs >= srcStat.mtimeMs && fs.readFileSync(OUT, 'utf8').includes(MARK)) {
      console.log('standalone-codex.js is up to date');
      return true;
    }
  }

  let code = fs.readFileSync(SRC, 'utf8');
  const anchor = '//#region src/host/config.ts';
  if (!code.includes(anchor)) {
    console.error('patch anchor (host config region) not found; dsh-pet layout changed');
    return false;
  }
  code = code.replace(anchor, `${PREAMBLE}\n${anchor}`);

  const credentialPattern = /\t\tcredentials: \{ resolve: async \(\) => void 0 \},/;
  if (!credentialPattern.test(code)) {
    console.error('patch anchor (standalone credentials shim) not found');
    return false;
  }
  code = code.replace(
    credentialPattern,
    '\t\tcredentials: { resolve: async (ref) => __petBalanceCredential(ref) },',
  );

  const queryPattern = /const result = await queryBalance\(\s*sel\.provider,/;
  if (!queryPattern.test(code)) {
    console.error('patch anchor (queryBalance call) not found');
    return false;
  }
  code = code.replace(queryPattern, 'const result = await queryBalance(__petBalanceProvider(sel.provider),');

  fs.writeFileSync(OUT, code);
  console.log(`built ${OUT}`);
  return true;
}

/** Apply a text transform in place, with backup + syntax gate + idempotence marker. */
function patchHelper(file, transform) {
  if (!fs.existsSync(file)) {
    console.error(`helper file not found: ${file}`);
    return false;
  }
  const original = fs.readFileSync(file, 'utf8');
  if (original.includes(HELPER_MARK)) {
    console.log(`${path.basename(file)} already patched`);
    return true;
  }
  const updated = transform(original);
  if (updated === original) {
    console.error(`${path.basename(file)}: patch anchors not found (dsh-pet changed?)`);
    return false;
  }
  const candidate = `${updated}\n${HELPER_MARK}\n`;
  const backup = `${file}.dsh-pet-orig`;
  fs.writeFileSync(backup, original); // refresh on every (re)patch after an upgrade
  fs.writeFileSync(file, candidate);
  if (!syntaxOk(file)) {
    fs.writeFileSync(file, original);
    console.error(`${path.basename(file)}: patched file failed syntax check, restored`);
    return false;
  }
  console.log(`patched ${file}`);
  return true;
}

function patchConstants(code) {
  return code.replace(
    'const BUBBLE_DURATION_MS = 10 * 1000;',
    `const BUBBLE_DURATION_MS = 10 * 1000;\nconst BALANCE_BUBBLE_DURATION_MS = ${BALANCE_HOLD_MS}; // patched: keep the balance bubble up`,
  );
}

function patchEvents(code) {
  let out = code;

  // Auto refresh: stock skips it when there is no percentage basis (money shape).
  const gate =
    'if (!manual && p === undefined) return; // 自动轮询没有百分比语义：没有档位依据，不弹（手动仍要给答复）';
  if (!out.includes(gate)) return code;
  out = out.replace(
    gate,
    'if (!manual && p === undefined && state.shape !== "money") return; // patched: money balance stays visible',
  );

  // showBalanceNow: hold the bubble instead of dismissing it after 10s.
  const showBlock =
    '// 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）\n' +
    '  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);\n' +
    '  this.bubbleTimer = window.setTimeout(() => {\n' +
    '    this.bubbleOn = false;\n' +
    '    this.renderBubble();\n' +
    '  }, BUBBLE_DURATION_MS);';
  if (!out.includes(showBlock)) return code;
  out = out.replace(showBlock, showBlock.replace('BUBBLE_DURATION_MS', 'BALANCE_BUBBLE_DURATION_MS'));

  // toggleBalanceDetail (end of file, right before the polling section): same hold.
  const toggleBlock = '  }, BUBBLE_DURATION_MS);\n};\n\n// ---------- 轮询组装';
  if (!out.includes(toggleBlock)) return code;
  out = out.replace(
    toggleBlock,
    '  }, BALANCE_BUBBLE_DURATION_MS);\n};\n\n// ---------- 轮询组装',
  );

  return out;
}

/**
 * Render the money bubble as `余额：¥x.xx（峰）` / `余额：¥x.xx（谷）`.
 *
 * Stock renders `余额（谷）¥x.xx`, with 峰/谷 in front of the amount as a lone
 * tier span, which reads as a stray icon in the bubble. Here the amount itself
 * becomes the tier span (so it keeps the tier colour: green #2e9e4f on the idle
 * tier, gold on peak) and the tier marker moves to a trailing parenthetical in
 * the same colour.
 *
 * The whole moneyRows function is rewritten, so the patch applies both to the
 * stock helper and to the earlier `余额：¥x.xx`-only version of this patch.
 */
function patchBalanceRows() {
  if (!fs.existsSync(SHARED)) {
    console.error(`helper file not found: ${SHARED}`);
    return false;
  }
  const original = fs.readFileSync(SHARED, 'utf8');
  if (original.includes('（峰）')) {
    console.log('shared-core.js balance row patch already applied');
    return true;
  }
  const head = 'function moneyRows(v) {';
  const tail = '\nconst moneyHandler = {';
  const start = original.indexOf(head);
  const end = original.indexOf(tail, start);
  if (start < 0 || end < 0) {
    console.error('shared-core.js: moneyRows anchor not found (dsh-pet changed?)');
    return false;
  }
  const replacement = [
    'function moneyRows(v) {',
    '\tconst visible = (v.wallets ?? []).filter((w) => Number(w.total) !== 0).sort((a, b) => (a.currency === "CNY" ? 0 : 1) - (b.currency === "CNY" ? 0 : 1));',
    '\tconst amount = visible.length > 0 ? visible.map((w) => (w.currency === "USD" ? "$" : "¥") + w.total).join("/") : "¥0.00";',
    '\t// patched: 金额作为着色片段，档位缩写放到末尾括号里（余额：¥x.xx（峰））',
    '\tconst tier = v.tier === "peak" ? "peak" : "idle";',
    '\tconst rows = [',
    '\t\t{',
    '\t\t\trole: "label",',
    '\t\t\ttext: "余额："',
    '\t\t},',
    '\t\t{',
    '\t\t\trole: "tier",',
    '\t\t\ttier,',
    '\t\t\ttext: amount',
    '\t\t}',
    '\t];',
    '\tif (v.tier) rows.push({',
    '\t\trole: "tier",',
    '\t\ttier,',
    '\t\ttext: tier === "peak" ? "（峰）" : "（谷）"',
    '\t});',
    '\treturn rows;',
    '}',
  ].join('\n');
  const updated = original.slice(0, start) + replacement + original.slice(end);
  const backup = `${SHARED}.dsh-pet-pre-rows`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(SHARED, `${updated}\n${ROWS_MARK}\n`);
  if (!syntaxOk(SHARED)) {
    fs.writeFileSync(SHARED, original);
    console.error('shared-core.js: balance row patch failed syntax check, restored');
    return false;
  }
  console.log('patched shared-core.js (balance rows)');
  return true;
}

/**
 * Show the balance the moment the helper starts.
 *
 * Stock records a baseline on the first /state pull and renders nothing, so the
 * bubble only appeared on the next balance write (up to eventsRefreshSec.balance
 * later). The balance leaf is a current reading, not an event, so it is safe to
 * render once at startup — the other leaves keep the baseline-only behaviour.
 */
function patchStartupBalance() {
  if (!fs.existsSync(EVENTS)) {
    console.error(`helper file not found: ${EVENTS}`);
    return false;
  }
  const original = fs.readFileSync(EVENTS, 'utf8');
  if (original.includes(STARTUP_MARK)) {
    console.log('events.js startup balance patch already applied');
    return true;
  }
  const anchor = '      applyMenuLeaf(s.sections ? s.sections.menu : null);\n      return true;';
  if (!original.includes(anchor)) {
    console.error('events.js: startup anchor not found (dsh-pet changed?)');
    return false;
  }
  const injected = [
    '      applyMenuLeaf(s.sections ? s.sections.menu : null);',
    '      // patched: 余额是"当前读数"而不是事件——启动首拉就把宿主里已有的余额显示出来；',
    '      // 其余叶子仍只记基线，避免重放旧气泡。',
    '      try {',
    '        const startupBalance = s.sections ? s.sections.balance : null;',
    '        if (startupBalance && startupBalance.data != null) applyBalanceLeaf(startupBalance);',
    '      } catch {}',
    '      return true;',
  ].join('\n');
  const updated = original.replace(anchor, injected);
  if (updated === original) {
    console.error('events.js: startup balance patch made no change');
    return false;
  }
  const backup = `${EVENTS}.dsh-pet-pre-startup`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(EVENTS, `${updated}\n${STARTUP_MARK}\n`);
  if (!syntaxOk(EVENTS)) {
    fs.writeFileSync(EVENTS, original);
    console.error('events.js: startup balance patch failed syntax check, restored');
    return false;
  }
  console.log('patched events.js (startup balance)');
  return true;
}

// Tier colors: idle keeps the stock green; peak swaps the stock red for gold so
// the bubble never reads as an error.
const PEAK_STYLE_OLD = '.pet-bub-tier-peak {\n        color: #e53935;\n      }';
const PEAK_STYLE_NEW = '.pet-bub-tier-peak {\n        /* patched: 峰值用金色，不用刺眼的红 */\n        color: #c9a227;\n      }';

function recolorPeak(html) {
  return html.includes(PEAK_STYLE_OLD) ? html.replace(PEAK_STYLE_OLD, PEAK_STYLE_NEW) : html;
}

// `余额：` + amount sit in one flex row with a gap; drop it so the bubble reads
// as a single string (`余额：¥64.87`, no space before the amount).
const ROW_GAP_ANCHOR = '      .pet-bub-tier {\n        font-weight: 700;\n      }';
const ROW_GAP_RULE =
  ROW_GAP_ANCHOR +
  '\n      /* dsh-pet balance row patch: 标签与金额之间不留 flex 间隙 */' +
  '\n      .pet-bub-row:has(> .pet-bub-tier) {\n        gap: 0;\n      }';

function tightenBalanceRow(html) {
  return html.includes(ROW_GAP_ANCHOR) && !html.includes('.pet-bub-row:has(> .pet-bub-tier)')
    ? html.replace(ROW_GAP_ANCHOR, ROW_GAP_RULE)
    : html;
}

/** index.html is markup, so patch it directly (no JS syntax gate) with a shape check. */
function patchIndexHtml() {
  if (!fs.existsSync(INDEX_HTML)) {
    console.error(`helper file not found: ${INDEX_HTML}`);
    return false;
  }
  const original = fs.readFileSync(INDEX_HTML, 'utf8');
  // Already patched: keep it, but follow DSH_PET_BALANCE_BUBBLE_SCALE changes.
  const scalePattern =
    /(--f0: calc\(var\(--dsh-pet-font-bubble, calc\(var\(--pet-size, 462px\) \* 0\.0455\)\) \* )([0-9.]+)(\);)/;
  if (original.includes(HELPER_MARK)) {
    if (!scalePattern.test(original)) {
      console.error('index.html: patched balance rule not recognizable (dsh-pet changed?)');
      return false;
    }
    let updated = original.replace(scalePattern, `$1${BALANCE_BUBBLE_SCALE}$3`);
    updated = tightenBalanceRow(recolorPeak(updated));
    if (updated !== original) {
      fs.writeFileSync(INDEX_HTML, updated);
      console.log(`index.html: balance bubble scale ${BALANCE_BUBBLE_SCALE} / peak color synced`);
    } else {
      console.log('index.html already patched');
    }
    return true;
  }
  const anchor = '      .pet-bubble.is-on {\n';
  if (!original.includes(anchor)) {
    console.error('index.html: bubble style anchor not found (dsh-pet changed?)');
    return false;
  }
  const rule = [
    '      /* dsh-pet balance visibility patch */',
    '      /* 余额（金额）气泡缩小一档：--f0 同时决定字号与盒子（内边距/圆角/宽度上限都锚在它上）；',
    '         碎碎念、工作状态气泡带 .is-whisper，不匹配这条规则，保持原尺寸 */',
    '      .pet-bubble:not(.is-whisper) {',
    `        --f0: calc(var(--dsh-pet-font-bubble, calc(var(--pet-size, 462px) * 0.0455)) * ${BALANCE_BUBBLE_SCALE});`,
    '      }',
    '',
  ].join('\n');
  const updated = tightenBalanceRow(recolorPeak(original.replace(anchor, `${rule}${anchor}`)));
  const backup = `${INDEX_HTML}.dsh-pet-orig`;
  fs.writeFileSync(backup, original); // refresh on every (re)patch after an upgrade
  fs.writeFileSync(INDEX_HTML, updated);
  const check = fs.readFileSync(INDEX_HTML, 'utf8');
  const count = check.split('.pet-bubble:not(.is-whisper)').length - 1;
  if (count !== 1 || !check.includes(HELPER_MARK)) {
    fs.writeFileSync(INDEX_HTML, original);
    console.error('index.html: patched file failed verification, restored');
    return false;
  }
  console.log(`patched ${INDEX_HTML}`);
  return true;
}

/**
 * Regroup the desktop context menu.
 *
 * Stock puts nine items on the first level, mixing everyday interactions with
 * maintenance actions (open site, display target, reload…). Here only the
 * everyday ones stay on top; the rare ones move into a 「工具」 submenu:
 *
 *   查看余额 / 碎碎念 / 对话 / 动作 ▸ / 工具 ▸ / 更多 ▸
 */
function patchMenu() {
  if (!fs.existsSync(SPRITE)) {
    console.error(`helper file not found: ${SPRITE}`);
    return false;
  }
  const original = fs.readFileSync(SPRITE, 'utf8');
  if (original.includes(MENU_MARK)) {
    console.log('sprite.js menu patch already applied');
    return true;
  }
  const head = '    // 桌面专属工具根项（打开网站 / 查看余额 / 碎碎念 / 对话 / 回到初始位置 / 重载配置）';
  const tail = '    // 第三方菜单项统一收在「更多」下';
  const treeStock =
    '    const tree = tools.concat(S.buildMenuTree(this.animations), more ? [more] : []);';
  const treePatched =
    '    const tree = tools.concat(S.buildMenuTree(this.animations), toolMenu, more ? [more] : []);';
  const start = original.indexOf(head);
  const end = original.indexOf(tail, start);
  if (start < 0 || end < 0 || (!original.includes(treeStock) && !original.includes(treePatched))) {
    console.error('sprite.js: context-menu anchors not found (dsh-pet changed?)');
    return false;
  }
  const block = [
    '    // patched: 一级只留常用互动项；打开网站/显示位置/回到初始位置/重载配置收进「工具」',
    "    const tools = [",
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
  let updated = original.slice(0, start) + block + original.slice(end);
  updated = updated.replace(treeStock, treePatched);
  const backup = `${SPRITE}.dsh-pet-pre-menu`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(SPRITE, `${updated}\n${MENU_MARK}\n`);
  if (!syntaxOk(SPRITE)) {
    fs.writeFileSync(SPRITE, original);
    console.error('sprite.js: menu patch failed syntax check, restored');
    return false;
  }
  const check = fs.readFileSync(SPRITE, 'utf8');
  if ((check.match(/label: '工具'/g) || []).length !== 1 || !check.includes('toolMenu, more ?')) {
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
function patchPetName() {
  if (!fs.existsSync(MAIN_JS)) {
    console.error(`helper file not found: ${MAIN_JS}`);
    return false;
  }
  const original = fs.readFileSync(MAIN_JS, 'utf8');
  if (original.includes(NAME_MARK)) {
    console.log('main.js name patch already applied');
    return true;
  }
  const anchor = "    tray.setToolTip('dsh-pet 桌面宠物');";
  if (!original.includes(anchor)) {
    console.error('main.js: tray tooltip anchor not found (dsh-pet changed?)');
    return false;
  }
  const updated = original.replace(
    anchor,
    `    tray.setToolTip('${PET_NAME}'); // patched: 程序名随宠物名`,
  );
  const backup = `${MAIN_JS}.dsh-pet-pre-name`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(MAIN_JS, `${updated}\n${NAME_MARK}\n`);
  if (!syntaxOk(MAIN_JS)) {
    fs.writeFileSync(MAIN_JS, original);
    console.error('main.js: name patch failed syntax check, restored');
    return false;
  }
  console.log(`patched main.js (tray tooltip → ${PET_NAME})`);
  return true;
}

const force = process.argv.includes('--force');
const ok = [
  buildStandalone(force),
  patchHelper(CONSTANTS, patchConstants),
  patchHelper(EVENTS, patchEvents),
  patchStartupBalance(),
  patchBalanceRows(),
  patchIndexHtml(),
  patchMenu(),
  patchPetName(),
];
process.exitCode = ok.every(Boolean) ? 0 : 1;

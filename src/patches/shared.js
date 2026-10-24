/**
 * Shared constants and helpers for the in-place dsh-pet patches.
 *
 * Every patcher is idempotent (marker comment), keeps a `*.dsh-pet-*` backup,
 * and is syntax-gated: a broken result is restored automatically.
 */
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
 *    - a 「查看日记」 entry that opens diary/viewer.html in the default browser.
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
const { PKG, STOCK_JS: SRC, PATCHED_JS: OUT } = require('../config');

const HELPER = path.join(PKG, 'runtime', 'electron-helper');
const CONSTANTS = path.join(HELPER, 'constants.js');
const EVENTS = path.join(HELPER, 'events.js');
const SHARED = path.join(HELPER, 'shared-core.js');
const SPRITE = path.join(HELPER, 'sprite.js');
const MAIN_JS = path.join(HELPER, 'main.js');
const PRELOAD = path.join(HELPER, 'preload.js');
const INDEX_HTML = path.join(HELPER, 'index.html');
const MARK = '/* dsh-pet standalone balance patch */';
const HELPER_MARK = '/* dsh-pet balance visibility patch */';
const STARTUP_MARK = '/* dsh-pet startup balance patch */';
const ROWS_MARK = '/* dsh-pet balance row patch */';
const MENU_MARK = '/* dsh-pet menu patch v2 */';
const DIARY_MENU_MARK = '/* dsh-pet diary menu patch */';
const IMPRESSION_MENU_MARK = '/* dsh-pet impression menu patch */';
const OPEN_PATH_MARK = '/* dsh-pet open-path patch */';
const NAME_MARK = '/* dsh-pet name patch */';
const PET_NAME = '大肥鱼';
// 菜单里的「查看日记」直接打开这个本地文件（由 src/diary.js 生成）。
const DIARY_VIEWER = path.resolve(PKG, '..', '..', '..', '..', 'dsh-pet', 'diary', 'viewer.html');
const DIARY_VIEWER_JS = DIARY_VIEWER.replace(/\\/g, '\\\\'); // JS 字符串字面量里的 Windows 路径
const DIARY_VIEWER_URL = `file:///${DIARY_VIEWER.replace(/\\/g, '/')}`;
const IMPRESSION_VIEWER = path.join(path.dirname(path.dirname(DIARY_VIEWER)), 'impressions', 'viewer.html');
const IMPRESSION_VIEWER_JS = IMPRESSION_VIEWER.replace(/\\/g, '\\\\');
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


module.exports = {
  PKG,
  SRC,
  OUT,
  HELPER,
  CONSTANTS,
  EVENTS,
  SHARED,
  SPRITE,
  MAIN_JS,
  PRELOAD,
  INDEX_HTML,
  MARK,
  HELPER_MARK,
  STARTUP_MARK,
  ROWS_MARK,
  MENU_MARK,
  DIARY_MENU_MARK,
  IMPRESSION_MENU_MARK,
  OPEN_PATH_MARK,
  NAME_MARK,
  PET_NAME,
  DIARY_VIEWER,
  DIARY_VIEWER_JS,
  DIARY_VIEWER_URL,
  IMPRESSION_VIEWER,
  IMPRESSION_VIEWER_JS,
  BALANCE_HOLD_MS,
  BALANCE_BUBBLE_SCALE,
  PREAMBLE,
  syntaxOk,
  patchHelper,
};

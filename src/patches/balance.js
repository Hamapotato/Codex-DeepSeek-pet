'use strict';

const fs = require('fs');
const path = require('path');
const { SRC, OUT, EVENTS, SHARED, INDEX_HTML, MARK, HELPER_MARK, STARTUP_MARK, ROWS_MARK, BALANCE_HOLD_MS, BALANCE_BUBBLE_SCALE, PREAMBLE, syntaxOk } = require('./shared');

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

module.exports = { buildStandalone, patchConstants, patchEvents, patchStartupBalance, patchBalanceRows, patchIndexHtml, recolorPeak, tightenBalanceRow };

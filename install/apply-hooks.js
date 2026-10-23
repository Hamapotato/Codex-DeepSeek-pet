#!/usr/bin/env node
'use strict';

/**
 * Write (or remove) the dsh-pet hook block in Codex's config.toml.
 *
 * The block is delimited by START/END comments, so the script can be re-run
 * after moving the project: it replaces its own block and leaves everything
 * else in the file alone. A timestamped backup is written before every change.
 *
 * Usage:
 *   node install/apply-hooks.js            # write / update
 *   node install/apply-hooks.js --dry-run  # print the block only
 *   node install/apply-hooks.js --remove   # delete the managed block
 *
 * After writing, Codex must be told to trust the hooks (startup prompt, or
 * /hooks → t): the trust records are keyed on the exact command line.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_DIR = path.resolve(__dirname, '..');
const HOOK = path.join(PROJECT_DIR, 'hook.js');
const NODE = process.execPath;

const START = '# >>> dsh-pet hooks (managed by install/apply-hooks.js) >>>';
const END = '# <<< dsh-pet hooks <<<';

const EVENTS = [
  { name: 'SessionStart', async: true },
  { name: 'UserPromptSubmit', async: false },
  { name: 'PostToolUse', async: true },
  { name: 'PermissionRequest', async: false },
  { name: 'Stop', async: false },
  { name: 'Interrupt', async: false },
];

function slash(p) {
  return p.replace(/\\/g, '/');
}

/** TOML basic-string body for the hook command (quotes around both paths). */
function commandBody() {
  return `\\"${slash(NODE)}\\" \\"${slash(HOOK)}\\"`;
}

function renderBlock() {
  const command = commandBody();
  const lines = [
    START,
    '# 事件 -> 桌宠动画/气泡。由 install/apply-hooks.js 生成，可重复执行。',
    `# project: ${slash(PROJECT_DIR)}`,
  ];
  for (const ev of EVENTS) {
    lines.push(
      '',
      `[[hooks.${ev.name}]]`,
      'hooks = [',
      `  { type = "command", command = "${command}", timeout = 10${ev.async ? ', async = true' : ''} },`,
      ']',
    );
  }
  lines.push(END);
  return lines.join('\n');
}

function stripManaged(text) {
  const start = text.indexOf(START);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return text;
  const before = text.slice(0, start).replace(/\s+$/, '');
  const after = text.slice(end + END.length).replace(/^\s+/, '');
  if (!after) return before ? `${before}\n` : '';
  return before ? `${before}\n\n${after}` : after;
}

function configPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const remove = process.argv.includes('--remove');
  const file = configPath();
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : '';

  if (!exists) {
    console.error(`Codex config not found: ${file}`);
    console.error('先运行一次 Codex（生成配置），或设置 CODEX_HOME 指向配置目录。');
    process.exitCode = 1;
    return;
  }

  if (!original.includes(START) && /#\s*dsh-pet\s*桌宠联动/.test(original)) {
    console.error('检测到一份未加管理标记的旧 dsh-pet hook 块。');
    console.error('请先手动删除从「# dsh-pet 桌宠联动」到最后一个 [[hooks.Interrupt]] 的内容，再重试。');
    process.exitCode = 1;
    return;
  }

  if (remove) {
    const updated = stripManaged(original);
    if (updated === original) {
      console.log('没有找到受管理的 hook 块，未改动。');
      return;
    }
    if (dryRun) {
      console.log('--- would remove the managed block from', file, '---');
      return;
    }
    backup(file, original);
    fs.writeFileSync(file, updated);
    console.log(`已移除 dsh-pet hook 块：${file}`);
    return;
  }

  const block = renderBlock();
  if (dryRun) {
    console.log(block);
    return;
  }

  const base = stripManaged(original).replace(/\s+$/, '');
  const updated = `${base}${base ? '\n\n' : ''}${block}\n`;
  if (updated === original) {
    console.log('hook 块已是最新，未改动。');
    return;
  }
  backup(file, original);
  fs.writeFileSync(file, updated);
  console.log(`已写入 dsh-pet hook 块：${file}`);
  console.log(`  node: ${NODE}`);
  console.log(`  hook: ${HOOK}`);
  console.log('');
  console.log('下一步：启动 Codex，在 “Hooks need review” 选择 “Trust all and continue”');
  console.log('（或打开 /hooks 按 t 信任）。改动命令/超时后需要重新信任。');
}

function backup(file, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.dsh-pet-backup-${stamp}`;
  fs.writeFileSync(target, content);
  console.log(`备份：${target}`);
}

main();

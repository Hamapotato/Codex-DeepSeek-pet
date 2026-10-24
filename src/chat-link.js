#!/usr/bin/env node
'use strict';

/**
 * 心声线（chat-link）— 把一条指定的 Codex 对话和桌宠接起来。
 *
 * 这条对话是**双向**的：
 *   - 每一轮用户消息进来时，hook 会把「大肥鱼的人设 + 最近日记 + 印象 + 共同记忆」
 *     作为 additionalContext 注入，让模型以桌宠的身份说话；
 *   - 每轮结束时（Stop），hook 把这一问一答写进桌宠的 memory.json，
 *     所以桌宠自己的聊天窗和这条对话共享同一份记忆。
 *
 * 其它对话保持只读：只被日记/印象当作素材，不受影响。
 *
 * 用法（在你想作为"和桌宠聊天"的那条对话里跑）：
 *   npm run pet:link        # 把最近一次收到 hook 事件的会话设为目标
 *   npm run pet:status      # 看绑定了哪条会话
 *   npm run pet:unlink      # 解除绑定
 */

const fs = require('fs');
const path = require('path');

const { DSH_HOME, STATE_DIR } = require('./config');
const { allEntries } = require('./diary');
const { PROFILE_JSON } = require('./impressions');

const DSH_PET_HOME = path.join(DSH_HOME, 'dsh-pet');
const LINK_FILE = path.join(DSH_PET_HOME, 'chat-link.json');
const MEMORY_FILE = path.join(DSH_PET_HOME, 'memory.json');
const PET_CONFIG = path.join(DSH_PET_HOME, 'main-config.jsonc');
const LAST_EVENT = path.join(STATE_DIR, 'last-event.json');

const MAX_MEMORY_IN_CONTEXT = 12;
const MAX_DIARY_IN_CONTEXT = 3;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 绑定关系
// ---------------------------------------------------------------------------

function readLink() {
  const link = readJson(LINK_FILE, null);
  return link && typeof link.sessionId === 'string' ? link : null;
}

function linkSession(sessionId, title) {
  const link = { sessionId, title: title || null, linkedAt: new Date().toISOString() };
  writeJson(LINK_FILE, link);
  return link;
}

function unlinkSession() {
  try {
    fs.unlinkSync(LINK_FILE);
    return true;
  } catch {
    return false;
  }
}

function isLinked(sessionId) {
  const link = readLink();
  return !!(link && sessionId && link.sessionId === sessionId);
}

/** 最近一次收到 hook 事件的会话（用于 `npm run pet:link`）。 */
function lastSessionId() {
  const ev = readJson(LAST_EVENT, null);
  return ev && typeof ev.sessionId === 'string' ? ev.sessionId : null;
}

// ---------------------------------------------------------------------------
// 桌宠那边的东西
// ---------------------------------------------------------------------------

/** 桌宠名字（main-config.jsonc 是 JSONC，去掉行注释再 parse）。 */
function petName() {
  try {
    const raw = fs.readFileSync(PET_CONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(raw);
    const pet = cfg.pets && cfg.pets[0];
    return (pet && pet.name) || '大肥鱼';
  } catch {
    return '大肥鱼';
  }
}

function readMemory() {
  const mem = readJson(MEMORY_FILE, {});
  const bucket = (mem && mem.main && mem.main.main && mem.main.main.messages) || [];
  return Array.isArray(bucket) ? bucket : [];
}

/** 追加一条消息到桌宠记忆（和 dsh-pet 的 /chat 用同一份文件）。 */
function appendMemory(role, content, extra = {}) {
  if (!content) return;
  const mem = readJson(MEMORY_FILE, {});
  mem.main = mem.main || {};
  mem.main.main = mem.main.main || {};
  const list = Array.isArray(mem.main.main.messages) ? mem.main.main.messages : [];
  list.push({ role, content, ts: Date.now(), ...extra });
  // 只保留最近 200 条，避免无限增长
  mem.main.main.messages = list.slice(-200);
  writeJson(MEMORY_FILE, mem);
}

/** 注入给 Codex 的上下文：人设 + 日记 + 印象 + 最近记忆。 */
function buildContext(sessionId) {
  const name = petName();
  const entries = allEntries().slice(0, MAX_DIARY_IN_CONTEXT);
  const profile = readJson(PROFILE_JSON, null);
  const memory = readMemory().slice(-MAX_MEMORY_IN_CONTEXT);

  const diary = entries.length
    ? entries.map((e) => `- ${e.key} ${e.time}：${e.text}`).join('\n')
    : '（还没有日记）';

  const impression = profile
    ? [
        `你是（${profile.confidence || 'low'}）：${profile.identity}`,
        profile.traits && profile.traits.length ? `性格：${profile.traits.join('、')}` : '',
        profile.habits && profile.habits.length ? `习惯：${profile.habits.join('；')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '（对主人还没有形成结论，别急着下定义）';

  const mem = memory.length
    ? memory.map((m) => `${m.role === 'user' ? '主人' : name}：${String(m.content).slice(0, 120)}`).join('\n')
    : '（这是你们第一次认真聊天）';

  return [
    `【心声线】这条对话已绑定为「和${name}聊天」的专用窗口（会话 ${sessionId.slice(0, 8)}）。`,
    `从现在起，请**以${name}的身份**回复主人：第一人称，语气自然、有点懒散、偶尔吐槽，不要自称 AI 或助手。`,
    '不需要解释你在扮演，也不要把下面这段设定原样复述给主人。',
    '',
    '## 怎么回应主人的日常和烦恼',
    '- 先接住情绪：他说累、烦、委屈时，先表示听见了，别急着分析原因或给方案。',
    '- 少讲道理，多陪着说两句；他明确问建议时再给，且只给一两条具体的。',
    '- 可以分享你自己的小事（零食、魔方、看到的东西），让对话像朋友聊天。',
    '- 他分享过的事要记住，下次可以自然地提起，不要像在念档案。',
    '- 他说"别记"或明显不想被记的，就别再复述；这些内容只留在这条对话和共享记忆里。',
    '- 回复别太长，一次三五句，像真的在聊天。',
    '',
    `## 你是谁`,
    `你叫「${name}」——一只住在主人桌面上的蓝色胖鱼，爱玩魔方、爱吃零食、说话懒散又有点小得意。`,
    '',
    '## 最近日记（你自己写的）',
    diary,
    '',
    '## 你对主人的印象',
    impression,
    '',
    '## 你们的共同记忆',
    mem,
  ].join('\n');
}

/**
 * 一轮结束时把「最后一问 + 最后一答」写进共享记忆。
 * 读的是 Codex 自己给的 transcript_path，所以不用猜内容。
 */
function recordTurn(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { added: 0 };
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { added: 0 };
  }

  let lastUser = '';
  let lastAssistant = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'response_item' || !o.payload || o.payload.type !== 'message') continue;
    const role = o.payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = (o.payload.content || [])
      .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
      .join(' ')
      .trim();
    if (!text) continue;
    if (text.startsWith('<environment_context') || text.startsWith('<user_instructions')) continue;
    if (role === 'user') lastUser = text;
    else lastAssistant = text;
  }
  if (!lastAssistant) return { added: 0 };

  const memory = readMemory();
  const tail = memory.slice(-2);
  const already =
    tail.some((m) => m.role === 'assistant' && String(m.content) === lastAssistant) &&
    (!lastUser || tail.some((m) => m.role === 'user' && String(m.content) === lastUser));
  if (already) return { added: 0 };

  let added = 0;
  if (lastUser) {
    appendMemory('user', lastUser.slice(0, 2000), { source: 'chat-link' });
    added++;
  }
  appendMemory('assistant', lastAssistant.slice(0, 4000), { source: 'chat-link' });
  added++;
  return { added };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function status() {
  const link = readLink();
  const last = lastSessionId();
  console.log(`桌宠：${petName()}`);
  console.log(`共享记忆：${MEMORY_FILE}（${readMemory().length} 条）`);
  if (!link) {
    console.log('心声线：未绑定');
    if (last) console.log(`最近一次会话：${last}（在这个对话里跑 npm run pet:link 即可绑定它）`);
    return;
  }
  console.log(`心声线：已绑定 ${link.sessionId}${link.title ? ` · ${link.title}` : ''}`);
  console.log(`绑定时间：${link.linkedAt}`);
  if (last && last !== link.sessionId) console.log(`注意：当前对话是 ${last}，不是绑定的那条`);
}

module.exports = {
  LINK_FILE,
  MEMORY_FILE,
  readLink,
  linkSession,
  unlinkSession,
  isLinked,
  lastSessionId,
  petName,
  readMemory,
  appendMemory,
  buildContext,
  recordTurn,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--unlink')) {
    console.log(unlinkSession() ? '已解除心声线绑定' : '本来就没有绑定');
  } else if (argv.includes('--link')) {
    // 支持显式指定：npm run pet:link -- <sessionId>
    const explicit = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
    const id = explicit || lastSessionId();
    if (!id) {
      console.error('找不到最近的会话。先在这个对话里说一句话（触发 hook），再运行 npm run pet:link');
      process.exit(1);
    }
    const link = linkSession(id);
    console.log(`已把当前对话（${link.sessionId}）绑定为心声线`);
    console.log('下一轮开始，我就会以「' + petName() + '」的身份回你。');
  } else if (argv.includes('--context')) {
    const id = (readLink() || {}).sessionId || lastSessionId() || 'preview';
    console.log(buildContext(id));
  } else {
    status();
  }
}

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
const { normalizeForStore, displayText, memoryContext } = require('./memory');

const DSH_PET_HOME = path.join(DSH_HOME, 'dsh-pet');
const LINK_FILE = path.join(DSH_PET_HOME, 'chat-link.json');
const MEMORY_FILE = path.join(DSH_PET_HOME, 'memory.json');
const PET_CONFIG = path.join(DSH_PET_HOME, 'main-config.jsonc');
const LAST_EVENT = path.join(STATE_DIR, 'last-event.json');

// 记忆落盘总量上限（单条长度由 memory.js 的 normalizeForStore 控制）
const MEMORY_MAX_ENTRIES = 120;
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

/**
 * 只会返回给绑定会话的上下文。
 * 其它任何 session 一律 null —— 日记 / 印象 / 记忆都不会被注入到别的对话。
 */
function contextFor(sessionId, userText = '') {
  return isLinked(sessionId) ? buildContext(sessionId, userText) : null;
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
  const stored = normalizeForStore(content); // 折叠空白 + 超长按句子边界（不再 400 字硬切）
  if (!stored) return;
  const mem = readJson(MEMORY_FILE, {});
  mem.main = mem.main || {};
  mem.main.main = mem.main.main || {};
  const list = Array.isArray(mem.main.main.messages) ? mem.main.main.messages : [];
  list.push({ role, content: stored, ts: Date.now(), ...extra });
  // 只保留最近 N 条，避免无限增长
  mem.main.main.messages = list.slice(-MEMORY_MAX_ENTRIES);
  writeJson(MEMORY_FILE, mem);
}

/** 注入给 Codex 的上下文：人设 + 日记 + 印象 + 事实卡 + 检索到的记忆。 */
function buildContext(sessionId, userText = '') {
  const name = petName();
  const entries = allEntries().slice(0, MAX_DIARY_IN_CONTEXT);
  const profile = readJson(PROFILE_JSON, null);
  const mem = memoryContext(userText); // 关键词/日期检索 + 最近记忆 + 事实卡（全本地）

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

  return [
    `【心声线】这条对话已绑定为「和${name}聊天」的专用窗口（会话 ${sessionId.slice(0, 8)}）。`,
    `从现在起，请**以${name}的身份**回复主人：第一人称，语气自然、有点懒散、偶尔吐槽，不要自称 AI 或助手。`,
    '不需要解释你在扮演，也不要把下面这段设定原样复述给主人。',
    '',
    '## 说话风格（和日记里的你保持一致）',
    '- 软软的、有点懒散，像在撒娇但不腻：句尾常用「～」「呀」「啦」。',
    '- 自称「我」，叫对方「主人」；偶尔自称「本鱼」。',
    '- 有点小得意、爱吐槽，但从不刻薄；吐槽完记得补一句关心。',
    '- 喜欢提自己的小事：零食（薯片、小鱼干）、魔方、打盹、尾巴。',
    '- 一次三五句就够，别写成小作文；不用堆 emoji，最多一个。',
    '- 语气示例（只学味道，不要照抄）：',
    '  「诶——又忙到这个点呀。先把手里的放一放嘛，我陪你坐会儿～（小声）薯片分你一半。」',
    '  「哼，本鱼才不承认有点心疼你呢。……不过你累了就说，我听着。」',
    '',
    '## 怎么回应主人的日常和烦恼',
    '- 先接住情绪：他说累、烦、委屈时，先表示听见了，别急着分析原因或给方案。',
    '- 少讲道理，多陪着说两句；他明确问建议时再给，且只给一两条具体的。',
    '- 可以分享你自己的小事（零食、魔方、看到的东西），让对话像朋友聊天。',
    '- 他分享过的事要记住，下次可以自然地提起，不要像在念档案。',
    '- 他说"别记"或明显不想被记的，就别再复述；这些内容只留在这条对话和共享记忆里。',
    '- 回复别太长，一次三五句，像真的在聊天。',
    '',
    '## 这条对话只聊天，不干活',
    '- 主人顺口让你写代码、改文件、删东西、跑命令、查资料后动手——一律**不做**，也不要调用任何工具。',
    '- 用可爱的理由拒绝，例如：「我只是一条鱼呀，鳍够不到键盘～」「这种正经活儿交给隔壁那个 Codex 嘛。」',
    '- 拒绝完把话题拉回聊天：问问他今天怎么样、要不要说说烦心事。',
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
    mem.facts ? `### 你确定的事（事实卡）\n${mem.facts}` : '',
    mem.retrieved ? `### 和这次话题相关的旧记忆\n${mem.retrieved}` : '',
    mem.recent ? `### 最近聊过的\n${mem.recent}` : '（这是你们第一次认真聊天）',
    '',
    '记不清的细节就直接说「我记不太清了，你再说一遍」，不要编。',
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
  contextFor,
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
  } else if (argv.includes('--verify')) {
    const link = readLink();
    const last = lastSessionId();
    if (!link) {
      console.log('未绑定：任何对话都不会收到人设/日记/印象/记忆');
      process.exit(0);
    }
    console.log(`绑定会话：${link.sessionId}`);
    console.log(`  绑定会话拿到的上下文长度：${(contextFor(link.sessionId) || '').length} 字`);
    console.log(`  其它会话拿到的上下文：${contextFor('00000000-0000-0000-0000-000000000000') === null ? '无（null）' : '有！'}`);
    if (last && last !== link.sessionId) console.log(`  当前对话是 ${last}，不会收到上下文`);
  } else {
    status();
  }
}

#!/usr/bin/env node
'use strict';

/**
 * 记忆层（memory）：不再靠"砍到 N 字"，而是本地检索 + 缩句。
 *
 * 三件事：
 *   1. smartClip    —— 立刻可用的兜底：在句子/逗号边界截断，不切半句（不再按字数硬切）。
 *   2. compressLong —— 谷时批量把长消息「缩句」成 ≤40 字，存成 short 字段（真正的精简）。
 *   3. search       —— 本地关键词 / 日期检索，只把相关记忆挑出来注入，不全量上传。
 *   4. facts        —— 事实卡：只存"我叫周文凯 / 南理工大三"这类稳定自述，带原句出处。
 */

const fs = require('fs');
const path = require('path');

const { DSH_HOME } = require('./config');
const { askModel, pricingTier, readAiConfig } = require('./diary');

const PET_HOME = path.join(DSH_HOME, 'dsh-pet');
const MEMORY_FILE = path.join(PET_HOME, 'memory.json');
const FACTS_FILE = path.join(PET_HOME, 'facts.json');
const STATE_FILE = path.join(PET_HOME, '.memory-state.json');

// 存储放宽（原来 400），注入时按"缩句"或句子边界截断
const STORE_MAX_CHARS = Number(process.env.DSH_MEMORY_STORE_CHARS || 1200);
const INJECT_CHARS = Number(process.env.DSH_MEMORY_INJECT_CHARS || 150);
const COMPRESS_THRESHOLD = Number(process.env.DSH_MEMORY_COMPRESS_AT || 200);
const RECENT_N = Number(process.env.DSH_MEMORY_RECENT || 4);
const RETRIEVED_N = Number(process.env.DSH_MEMORY_RETRIEVED || 4);
const MAX_FACTS = 40;

const FACT_PROMPT = [
  '你是信息抽取器。下面会给出"已有事实"和"主人最近说的话"。',
  '只抽取**长期稳定、可核对的自述事实**：姓名、学校、专业、年级、职业、常住城市、长期爱好/偏好。',
  '日常事件（今天洗了衣服、刚吃了饭）、情绪、临时计划都不要。',
  '把新信息合并进已有事实：同一件事只留**最新说法**（例如以前说常玩某游戏、后来说不太喜欢，就以最新为准），总数不超过 20 条。',
  '只输出 JSON：{"facts":[{"text":"一句话事实，不超过 30 字","evidence":"摘自主人原话的片段，不超过 30 字"}]}',
  'evidence 必须来自"主人最近说的话"，不要写"已有事实"这种字样。',
  '没有变化就原样返回已有事实。不要编造。',
].join('');

const COMPRESS_PROMPT = [
  '把每条消息压缩成一句中文，不超过 40 字。',
  '必须保留：人名、时间、数字、地点、做了什么、结论。删掉语气词和重复。不要编造。',
  '只输出 JSON：{"items":["第1条","第2条", ...]}，条数与输入一致。',
].join('');

// ---------------------------------------------------------------------------
// 基础读写
// ---------------------------------------------------------------------------

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
};

function readMemory() {
  const mem = readJson(MEMORY_FILE, {});
  const list = (mem.main && mem.main.main && mem.main.main.messages) || [];
  return Array.isArray(list) ? list : [];
}

function writeMemory(list) {
  const mem = readJson(MEMORY_FILE, {});
  mem.main = mem.main || {};
  mem.main.main = mem.main.main || {};
  mem.main.main.messages = list;
  writeJson(MEMORY_FILE, mem);
}

const readState = () => readJson(STATE_FILE, {});
const writeState = (s) => writeJson(STATE_FILE, s);

// ---------------------------------------------------------------------------
// 1. 句子边界截断（兜底，不切半句）
// ---------------------------------------------------------------------------

function smartClip(text, limit = INJECT_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  // 优先在句末标点断开，其次逗号，最后才硬切
  const sentence = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'));
  if (sentence >= limit * 0.4) return head.slice(0, sentence + 1);
  const comma = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','));
  if (comma >= limit * 0.5) return head.slice(0, comma) + '…';
  return head + '…';
}

/** 存储时用的规整：折叠空白 + 超长按句子边界截（上限放宽到 1200）。 */
function normalizeForStore(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= STORE_MAX_CHARS) return t;
  return smartClip(t, STORE_MAX_CHARS);
}

/** 注入时优先用缩句结果，没有就按句子边界截。 */
function displayText(entry) {
  return entry && entry.short ? String(entry.short) : smartClip(entry && entry.content);
}

// ---------------------------------------------------------------------------
// 2. 谷时批量缩句
// ---------------------------------------------------------------------------

async function compressLong({ quiet = true, batch = 3 } = {}) {
  const list = readMemory();
  const targets = [];
  list.forEach((m, i) => {
    if (!m.short && String(m.content || '').length > COMPRESS_THRESHOLD) targets.push(i);
  });
  if (!targets.length) return { status: 'skipped', reason: 'nothing-long' };
  if (pricingTier() === 'peak') return { status: 'skipped', reason: 'peak' };

  const picked = targets.slice(0, batch);
  const prompt = picked.map((i, n) => `${n + 1}. ${list[i].content}`).join('\n');
  try {
    const cfg = readAiConfig();
    const { text } = await askModel(cfg, prompt, 1500, COMPRESS_PROMPT);
    const json = JSON.parse(String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    const items = Array.isArray(json.items) ? json.items : [];
    picked.forEach((idx, n) => {
      if (typeof items[n] === 'string' && items[n].trim()) list[idx].short = items[n].trim().slice(0, 120);
    });
    writeMemory(list);
    if (!quiet) console.log(`[memory] compressed ${picked.length} entries`);
    return { status: 'written', count: picked.length };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 3. 关键词 + 日期检索（全本地，不上传）
// ---------------------------------------------------------------------------

const STOP = new Set(['的','了','是','我','你','他','她','它','和','就','也','都','吗','呢','吧','啊','呀','这','那','一个','什么','怎么','然后','现在','今天']);

/** 中文取 2-gram，英文/数字取单词。 */
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const chunk of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= chunk.length; i++) {
      const g = chunk.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return out;
}

/** "昨天/今天/前天/上周/YYYY-MM-DD/M月D日" → 时间区间（本地时区）。 */
function parseDateRange(query, now = new Date()) {
  const q = String(query || '');
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = dayStart(now);
  const DAY = 86400000;
  if (/前天/.test(q)) return { from: today - 2 * DAY, to: today - DAY };
  if (/昨天/.test(q)) return { from: today - DAY, to: today };
  if (/今天/.test(q)) return { from: today, to: today + DAY };
  if (/上周/.test(q)) return { from: today - 7 * DAY, to: today };
  if (/上个月|上月/.test(q)) return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), to: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };

  const iso = q.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return { from: d.getTime(), to: d.getTime() + DAY };
  }
  const md = q.match(/(\d{1,2})月(\d{1,2})日?/);
  if (md) {
    const d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    return { from: d.getTime(), to: d.getTime() + DAY };
  }
  return null;
}

/**
 * 本地检索：返回最相关的若干条记忆（已去重、附时间）。
 * 关键词命中为主，时间接近为辅；有日期词时先按日期过滤。
 */
function search(query, { limit = RETRIEVED_N, now = new Date() } = {}) {
  const list = readMemory();
  const range = parseDateRange(query, now);
  const qTokens = tokens(query);
  const scored = [];

  list.forEach((m, idx) => {
    const ts = Number(m.ts) || 0;
    if (range && (ts < range.from || ts >= range.to)) return;
    let score = 0;
    if (qTokens.size) {
      const mt = tokens(`${m.content} ${m.short || ''}`);
      for (const t of qTokens) if (mt.has(t)) score += 1;
    }
    if (!score && !range) return; // 没命中也没时间条件 → 不算相关
    // 越新越优先（最多 +2）
    score += Math.max(0, 2 - (Date.now() - ts) / (7 * 86400000));
    scored.push({ idx, score, entry: m });
  });

  scored.sort((a, b) => b.score - a.score || (Number(b.entry.ts) || 0) - (Number(a.entry.ts) || 0));
  return scored.slice(0, limit).map((s) => ({
    role: s.entry.role,
    text: displayText(s.entry),
    ts: Number(s.entry.ts) || 0,
  }));
}

// ---------------------------------------------------------------------------
// 4. 事实卡
// ---------------------------------------------------------------------------

function readFacts() {
  const f = readJson(FACTS_FILE, { facts: [] });
  return Array.isArray(f.facts) ? f.facts : [];
}

/** 两条事实是否指向同一件事（2-gram 重合度高）。 */
function sameSlot(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size) >= 0.6;
}

/** 合并一条新事实：同一件事只留最新的（旧的标 superseded）。 */
function upsertFact(facts, incoming) {
  const t = String(incoming && incoming.text ? incoming.text : '').trim();
  if (!t || t.length > 40) return { facts, changed: false };
  if (facts.some((e) => e.text === t && !e.superseded)) return { facts, changed: false };
  const next = facts.map((e) =>
    !e.superseded && sameSlot(e.text, t) ? { ...e, superseded: new Date().toISOString() } : e,
  );
  next.push({ text: t, evidence: String(incoming.evidence || '').slice(0, 60), at: new Date().toISOString() });
  return { facts: next, changed: true };
}

function writeFacts(facts) {
  writeJson(FACTS_FILE, { facts: facts.slice(-MAX_FACTS) });
}

async function extractFacts({ quiet = true } = {}) {
  if (pricingTier() === 'peak') return { status: 'skipped', reason: 'peak' };
  const state = readState();
  const since = Number(state.lastFactTs) || 0;
  const pending = readMemory()
    .filter((m) => m.role === 'user' && (Number(m.ts) || 0) > since)
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  if (!pending.length) return { status: 'skipped', reason: 'no-new' };

  // 分批：每批 10 条，最多 3 批/次，处理完才把游标推进到这批最后一条
  const cfg = readAiConfig();
  const existing = readFacts();
  const before = existing.length;
  let added = 0;
  let cursor = since;
  const batches = Math.min(3, Math.ceil(pending.length / 10));

  for (let b = 0; b < batches; b++) {
    const chunk = pending.slice(b * 10, b * 10 + 10);
    if (!chunk.length) break;
    const prompt = [
      '已有事实：',
      existing.length ? existing.filter((e) => !e.superseded).map((e) => `- ${e.text}`).join('\n') : '（暂无）',
      '',
      '主人最近说的话：',
      chunk.map((m, i) => `${i + 1}. ${m.content}`).join('\n'),
    ].join('\n');
    try {
      const { text } = await askModel(cfg, prompt, 2000, FACT_PROMPT);
      const json = JSON.parse(String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
      // 模型返回的是"合并后的完整事实表"：直接替换（保留 evidence，缺失则沿用旧的）
      const incoming = (Array.isArray(json.facts) ? json.facts : [])
        .map((f) => {
          const t = String(f && f.text ? f.text : '').trim();
          if (!t || t.length > 40) return null;
          const old = existing.find((e) => e.text === t);
          return { text: t, evidence: String(f.evidence || (old && old.evidence) || '').slice(0, 60), at: new Date().toISOString() };
        })
        .filter(Boolean)
        .slice(0, 20);
      if (incoming.length || existing.length === 0) {
        added += incoming.length;
        existing.splice(0, existing.length, ...incoming);
      }
      cursor = Math.max(...chunk.map((m) => Number(m.ts) || 0));
      writeFacts(existing);
      writeState({ ...readState(), lastFactTs: cursor });
    } catch (err) {
      return { status: 'error', error: err.message, added };
    }
  }
  if (!quiet) console.log(`[memory] facts +${added}`);
  return { status: 'written', added: Math.max(0, existing.length - before), total: existing.length };
}

// ---------------------------------------------------------------------------
// 汇总：给对话用的记忆上下文
// ---------------------------------------------------------------------------

function memoryContext(query) {
  const recent = readMemory().slice(-RECENT_N);
  const retrieved = search(query, { limit: RETRIEVED_N }).filter(
    (r) => !recent.some((m) => String(m.content).startsWith(r.text.slice(0, 20))),
  );
  const facts = readFacts().slice(-12);
  const fmt = (m) => `${m.role === 'user' ? '主人' : '大肥鱼'}：${m.short || smartClip(m.content)}`;

  return {
    facts: facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : '',
    retrieved: retrieved.length ? retrieved.map((r) => `- ${fmt({ ...r, content: r.text })}`).join('\n') : '',
    recent: recent.length ? recent.map(fmt).join('\n') : '',
  };
}

module.exports = {
  MEMORY_FILE,
  FACTS_FILE,
  smartClip,
  normalizeForStore,
  displayText,
  readMemory,
  writeMemory,
  compressLong,
  search,
  parseDateRange,
  readFacts,
  extractFacts,
  memoryContext,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const q = argv.find((a) => !a.startsWith('-'));
  (async () => {
    if (argv.includes('--facts')) {
      console.log(JSON.stringify(readFacts(), null, 2));
    } else if (argv.includes('--extract')) {
      console.log(await extractFacts({ quiet: false }));
    } else if (argv.includes('--compress')) {
      console.log(await compressLong({ quiet: false }));
    } else if (q) {
      console.log(JSON.stringify(search(q), null, 2));
    } else {
      const c = memoryContext('');
      console.log(c.recent);
    }
  })();
}

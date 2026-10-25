#!/usr/bin/env node
'use strict';

/**
 * 大肥鱼的日记
 *
 * 读当天的 Codex 会话记录（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl），
 * 只抽出「用户到底让它干了什么」，压成一份很短的清单，交给 DeepSeek 写一段
 * 80～120 字的日记（第一人称，带一点情绪和吐槽），存成 Markdown。
 *
 * 省钱的做法：
 *   - 只取 user 提问，不取助手回复、不取工具输出（那些才是 token 大头）；
 *   - 每条截断到 140 字，每天最多 40 条，输入通常 1～3k token；
 *   - 输出上限 220 token；
 *   - 会话指纹没变就直接跳过，不重复调用模型；默认还有 10 分钟冷却。
 *
 * 用法：
 *   node src/diary.js                # 写今天的（必要时）
 *   node src/diary.js --date 2026-10-24
 *   node src/diary.js --force        # 忽略指纹/冷却，重写
 *   node src/diary.js --dry-run      # 只打印将要发送的内容，不调用 API
 *   node src/diary.js --list         # 列出已有的日记
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const {
  DSH_HOME,
  CODEX_HOME,
  CODEX_SESSIONS,
  DIARY_DIR,
  STANDALONE_RUNTIME,
  ROUTE,
} = require('./config');
const { writeViewer } = require('./diary-view');

const AI_CONFIG = path.join(DSH_HOME, 'dsh-pet', 'standalone-ai.json');
const STATE_FILE = path.join(DIARY_DIR, '.state.json');
// 重建期间挡住看门狗的自动写入（否则它会读到被清空的状态，抢先写一条）
const LOCK_FILE = path.join(DIARY_DIR, '.rebuild.lock');
// 峰时先记账、谷时再写：待写素材按日期排队
const PENDING_FILE = path.join(DIARY_DIR, '.pending.json');
// 写入互斥：看门狗和手动命令可能同时想写，串行化避免同一条被写两次
const WRITE_LOCK = path.join(DIARY_DIR, '.write.lock');

const MAX_ITEMS = 40;
const MAX_ITEM_CHARS = 140;
// 一篇日记覆盖多少条提问：关闭 Codex 时门槛低一些，运行中攒够一大段才写。
const MIN_TURNS_CLOSE = Number(process.env.DSH_DIARY_MIN_TURNS_CLOSE || 3);
const MIN_TURNS_MIDRUN = Number(process.env.DSH_DIARY_MIN_TURNS_MIDRUN || 20);
// deepseek-flash 会先写 reasoning_content 再写正文，预算太小会让正文被截断甚至为空。
// 放宽到 3000：思考 + 更长的正文都有余地，实际用量仍然由提示词控制。
const DEFAULT_MAX_TOKENS = Number(process.env.DSH_DIARY_MAX_TOKENS || 3000);

const SYSTEM_PROMPT = [
  '你是「大肥鱼」——一只住在主人桌面上的蓝色胖鱼，爱玩魔方、爱吃零食，说话懒散又有点小得意。',
  '下面列着主人这一段时间让 Codex 做的事。你可以照着写今天的日记，也可以完全不写这些事。',
  '写什么都行：吐槽、抱怨、愿望、发呆时冒出来的念头、对主人的评价、想吃的零食，想到什么写什么。',
  '第一人称，自然口语，80～300 个汉字；只输出正文，不要标题、不要列表、不要 Markdown、不要引号。',
].join('');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 → YYYY-MM-DD */
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dayDir(key) {
  const [y, m, d] = key.split('-');
  return path.join(CODEX_SESSIONS, y, m, d);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function rebuildInProgress() {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 5 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * DeepSeek 计价档位（北京时间，工作日 9–12、14–18 为峰）。
 * 峰时不调用模型：只把待写素材记进 .pending.json，等谷时再上传。
 */
function pricingTier(now = new Date()) {
  // 测试/应急：DSH_DIARY_FORCE_TIER=peak|idle 可强制档位
  const forced = String(process.env.DSH_DIARY_FORCE_TIER || '').trim();
  if (forced === 'peak' || forced === 'idle') return forced;
  const day = now.getDay(); // 0 = 周日
  if (day === 0 || day === 6) return 'idle';
  const h = now.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18) ? 'peak' : 'idle';
}

function readQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    return q && typeof q === 'object' ? q : {};
  } catch {
    return {};
  }
}

function writeQueue(queue) {
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

/** 按 (时间戳, 文本) 去重后按时间排序。 */
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const sig = `${it.ts}|${it.text}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(it);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** 有排队素材的日期（看门狗用来在启动/谷时补写）。 */
function pendingDates() {
  const q = readQueue();
  return Object.keys(q).filter((k) => Array.isArray(q[k]) && q[k].length > 0);
}

/**
 * 写入互斥锁（跨进程）。拿不到就跳过这一轮——宁可晚一点，也不要同一条被写两次。
 * 超过 5 分钟的锁视为崩溃残留，可以直接清掉。
 */
function acquireWriteLock() {
  try {
    fs.mkdirSync(DIARY_DIR, { recursive: true });
    fs.writeFileSync(WRITE_LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(WRITE_LOCK).mtimeMs > 5 * 60 * 1000) {
        fs.unlinkSync(WRITE_LOCK);
        fs.writeFileSync(WRITE_LOCK, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch {}
    return false;
  }
}

function releaseWriteLock() {
  try {
    fs.unlinkSync(WRITE_LOCK);
  } catch {}
}

/** 密钥、长 token 之类不写进提示词，避免日记把敏感串带上。 */
function scrub(text) {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***');
}

function compact(text) {
  return scrub(String(text)).replace(/\s+/g, ' ').trim();
}

/** 跳过 Codex 自己注入的上下文，只留下用户真的打出来的话。 */
function isInjected(text) {
  if (!text) return true;
  if (text.startsWith('<environment_context')) return true;
  if (text.startsWith('<user_instructions')) return true;
  if (text.startsWith('# AGENTS.md')) return true;
  if (text.includes('<environment_context>')) return true;
  if (text.startsWith('<task-') || text.startsWith('</task-')) return true;
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) return true;
  if (text.startsWith('<local-command-stdout>')) return true;
  if (text.startsWith('[Request interrupted')) return true;
  if (text.startsWith('<turn_aborted')) return true;
  if (text.startsWith('<in-app-browser-context')) return true;
  if (text.startsWith('<permissions instructions')) return true;
  if (text.startsWith('This session is being continued')) return true;
  if (/^<\/?[a-z_]+>$/.test(text)) return true;
  return false;
}

/** 本地某一天的 00:00（毫秒）。 */
function dayStartMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** 心声线绑定的 session id（没绑定返回 null）。 */
function linkedSessionId() {
  try {
    const link = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'dsh-pet', 'chat-link.json'), 'utf8'));
    return link && typeof link.sessionId === 'string' ? link.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * 「心声线」那条对话默认**也算素材**（倾诉、日常、烦恼都会进日记和印象）。
 * 如果哪天不想让它进，设 DSH_DIARY_EXCLUDE_CHAT=1。
 */
function linkedChatSessionId() {
  return process.env.DSH_DIARY_EXCLUDE_CHAT === '1' ? linkedSessionId() : null;
}

/** 递归列出目录下所有 rollout 文件。 */
function walkJsonl(dir, out) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * 候选会话文件：**所有** rollout（不限当天目录）+ 全部归档会话。
 *
 * 关键点：一个会话从哪天开始，文件就一直在那天的目录里——比如 10-21 开的
 * 会话今天还在聊，它仍然躺在 sessions/2026/10/21/ 下。所以不能只扫当天目录。
 * 用 mtime 做一次廉价预筛（今天动过的文件才可能含今天的消息），真正的
 * 日期判断交给 extractAsks 按每条消息的 timestamp 做。
 */
function candidateFiles(key) {
  const since = dayStartMs(key) - 2 * 60 * 60 * 1000; // 留 2 小时时差/时钟偏差
  const all = walkJsonl(path.join(CODEX_SESSIONS || path.join(CODEX_HOME, 'sessions')), []);
  walkJsonl(path.join(CODEX_HOME, 'archived_sessions'), all);
  const chatSession = linkedChatSessionId(); // 默认 null（含进去）；DSH_DIARY_EXCLUDE_CHAT=1 时才有值
  const out = [];
  for (const f of all) {
    if (chatSession && path.basename(f).includes(chatSession)) continue;
    try {
      if (fs.statSync(f).mtimeMs >= since) out.push(f);
    } catch {}
  }
  return out.sort();
}

function fingerprint(files) {
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    const st = fs.statSync(f);
    hash.update(`${path.basename(f)}:${st.size}:${Math.round(st.mtimeMs)}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

/** 解析缓存：文件没变（size+mtime 相同）就不重复解析几 MB 的 JSONL。 */
const messageCache = new Map();

/** 读出一个会话文件里的全部用户提问：[{ ts, time, text }]（带缓存）。 */
function readUserMessages(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  const cached = messageCache.get(file);
  if (cached && cached.stamp === stamp) return cached.items;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const items = [];
  // 文件名里带着 session id（rollout-...-<uuid>.jsonl），用来识别"这条消息来自哪条对话"
  const idMatch = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const session = idMatch ? idMatch[0] : null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload;
    if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

    const parts = [];
    for (const c of payload.content || []) {
      if (c && typeof c.text === 'string') parts.push(c.text);
    }
    const text = compact(parts.join(' '));
    if (isInjected(text)) continue;
    if (text.startsWith('/')) continue; // /compact 一类的命令，不算"让它干的事"

    const time = obj.timestamp ? new Date(obj.timestamp) : null;
    if (!time || Number.isNaN(time.getTime())) continue;

    const clipped = text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text;
    items.push({
      ts: time.getTime(),
      time: `${pad2(time.getHours())}:${pad2(time.getMinutes())}`,
      text: clipped,
      session,
    });
  }

  messageCache.set(file, { stamp, items });
  return items;
}

/**
 * 当天的用户提问清单（跨全部会话）：[{ ts, time, text }]
 *
 * 不按"文件属于哪天"筛选，而是按**每条消息的时间戳**落在本地当天——这样：
 *   - 10-21 开始、今天还在用的会话（文件待在 10-21 目录）也算；
 *   - 归档会话里今天说的话也算；
 *   - 同一条会话跨午夜时，昨天/今天各自归位；
 *   - 与 cwd / 项目无关，Codex 里所有对话都会进来。
 */
function extractAsks(key) {
  const items = [];
  const used = new Set();
  const seen = new Set();

  for (const file of candidateFiles(key)) {
    let contributed = false;
    for (const m of readUserMessages(file)) {
      if (dayKey(new Date(m.ts)) !== key) continue;
      // 同一句话可能同时出现在 sessions 和 archived 的副本里：按 (时间, 内容) 去重
      const signature = `${m.ts}|${m.text}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      items.push(m);
      contributed = true;
    }
    if (contributed) used.add(file);
  }

  items.sort((a, b) => a.ts - b.ts);
  return { items, files: [...used] };
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

function readAiConfig() {
  const cfg = JSON.parse(fs.readFileSync(AI_CONFIG, 'utf8'));
  if (!cfg || !cfg.apiKey || !cfg.baseUrl) {
    throw new Error('standalone-ai.json 缺少 apiKey/baseUrl');
  }
  return cfg;
}

function postJson(urlString, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body));
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

async function askModel(cfg, userPrompt, maxTokens, systemPrompt = SYSTEM_PROMPT) {
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const res = await postJson(
    `${base}/chat/completions`,
    { authorization: `Bearer ${cfg.apiKey}` },
    {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 1.0,
      stream: false,
    },
    Number(cfg.timeoutMs) || 30000,
  );

  if (res.status !== 200) {
    throw new Error(`API ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const json = JSON.parse(res.text);
  const text = (json.choices && json.choices[0] && json.choices[0].message
    && json.choices[0].message.content
    ? json.choices[0].message.content
    : ''
  )
    .trim()
    .replace(/^["'“”]|["'“”]$/g, '');
  if (!text) throw new Error('模型返回了空内容');
  return { text, usage: json.usage || null };
}

// ---------------------------------------------------------------------------
// 写文件 / 通知桌宠
// ---------------------------------------------------------------------------

function diaryPath(key) {
  return path.join(DIARY_DIR, `${key}.md`);
}

/** 一天的日记可能有多个时间点：`## 15:30 · 8 件事` */
const SECTION_RE = /^##\s+(\d{1,2}:\d{2})\s*(?:·\s*(\d+)\s*件事)?/;

function readDayEntries(key) {
  const file = diaryPath(key);
  if (!fs.existsSync(file)) return [];
  migrateLegacyDay(key); // 老格式（整天一大段）先就地转成带时间的小节
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { time: m[1].padStart(5, '0'), count: m[2] ? Number(m[2]) : 0, text: '', tokens: null };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('<!--')) {
      const tok = /(\d+)\/(\d+)\s*tok/.exec(line);
      if (tok) cur.tokens = { in: Number(tok[1]), out: Number(tok[2]) };
      continue;
    }
    const t = line.trim();
    if (t) cur.text += (cur.text ? ' ' : '') + t;
  }
  if (cur) out.push(cur);
  return out.filter((e) => e.text);
}

/** 老版本（一整天一大段、没有 ## 小节）就地转成一条带时间的记录。 */
function migrateLegacyDay(key) {
  const file = diaryPath(key);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  if (/^##\s+\d{1,2}:\d{2}/m.test(raw)) return;
  const body = raw
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() && !l.startsWith('<!--'))
    .join(' ')
    .trim();
  if (!body) return;
  const st = readState()[key] || {};
  const at = st.generatedAt ? new Date(st.generatedAt) : null;
  const when = at ? `${pad2(at.getHours())}:${pad2(at.getMinutes())}` : '00:00';
  const count = st.entries || 0;
  // 迁移会重写文件，先留一份原样备份
  try {
    const stamp = new Date();
    const suffix = `${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}${pad2(stamp.getSeconds())}`;
    fs.copyFileSync(file, `${file}.bak-legacy-${suffix}`);
  } catch {}
  fs.writeFileSync(
    file,
    [`# ${key}`, '', `## ${when} · ${count} 件事`, '', body, '', `<!-- ${count} 条 -->`, ''].join('\n'),
    'utf8',
  );
  // 老记录的截止时间 = 当时的生成时间：之后新增的提问才进下一条日记，避免重复写一遍。
  const state = readState();
  state[key] = {
    ...(state[key] || {}),
    lastTs: (state[key] && state[key].lastTs) || (at ? at.getTime() : 0),
    entries: Array.isArray(state[key] && state[key].entries)
      ? state[key].entries
      : [{ time: when, count }],
  };
  writeState(state);
}

/** 追加一条日记小节（按时间自然增长）。 */
function appendEntry(key, entry) {
  migrateLegacyDay(key);
  const file = diaryPath(key);
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${key}\n\n`, 'utf8');
  const meta = [
    `${entry.count} 条`,
    entry.tokens ? `${entry.tokens.in}/${entry.tokens.out} tok` : null,
    entry.model || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const block = [`## ${entry.time} · ${entry.count} 件事`, '', entry.text, '', `<!-- ${meta} -->`, ''].join('\n');
  const existing = fs.readFileSync(file, 'utf8');
  const prefix = existing.trim() && !existing.endsWith('\n\n') ? '\n' : '';
  fs.appendFileSync(file, prefix + block, 'utf8');
  // 只追加：写完后旧内容必须原样还在，否则立刻报错（防止未来改崩成"整篇重写"）
  const after = fs.readFileSync(file, 'utf8');
  if (!after.startsWith(existing)) {
    throw new Error(`append check failed: existing content changed in ${file}`);
  }
}

/** 所有日记条目，最新的在前。 */
function allEntries() {
  if (!fs.existsSync(DIARY_DIR)) return [];
  const keys = fs
    .readdirSync(DIARY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
  const out = [];
  for (const key of keys) {
    for (const e of readDayEntries(key)) out.push({ key, ...e });
  }
  return out.reverse();
}

/** 把所有日记汇总成一个 index.md，方便直接翻（也方便丢进编辑器/笔记软件）。 */

function writeIndex() {
  if (!fs.existsSync(DIARY_DIR)) return;
  const entries = allEntries();
  const parts = ['# 大肥鱼的日记', ''];
  let lastKey = null;
  for (const e of entries) {
    if (e.key !== lastKey) {
      parts.push(`## ${e.key}`, '');
      lastKey = e.key;
    }
    parts.push(`### ${e.time}`, '', e.text, '');
  }
  fs.writeFileSync(path.join(DIARY_DIR, 'index.md'), parts.join('\n'), 'utf8');
  writeViewer(entries, DIARY_DIR);
}

/** 按"两条提问间隔 > gapMs"把一段消息切成几段（重建当天时用）。 */
function splitSegments(items, gapMs = 60 * 60 * 1000) {
  const out = [];
  let cur = [];
  for (const it of items) {
    if (cur.length && it.ts - cur[cur.length - 1].ts > gapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

function buildPrompt(key, seg, truncated) {
  const span = seg.length > 1 ? `${seg[0].time}–${seg[seg.length - 1].time}` : seg[0].time;
  return [
    `日期：${key}（${span}）`,
    `这一段主人让我做的事（共 ${seg.length} 条${truncated ? '，当天更早的已省略' : ''}）：`,
    ...seg.map((a) => `${a.time} ${a.text}`),
  ].join('\n');
}

function notifyPet(message) {
  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(STANDALONE_RUNTIME, 'utf8'));
  } catch {
    return Promise.resolve(false);
  }
  if (!runtime || !Number.isInteger(runtime.port) || !runtime.token) return Promise.resolve(false);

  const body = Buffer.from(JSON.stringify({ text: message, duration: 9000, anim: false }));
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: runtime.port,
        path: `${ROUTE}/broadcast?pet=main&surface=any`,
        method: 'POST',
        timeout: 1500,
        headers: {
          'x-dsh-pet-token': runtime.token,
          'content-type': 'application/json',
          'content-length': body.length,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 写一条日记（一天可以有多条，每条只覆盖"上次写完之后新增的提问"）。
 *
 * reason:
 *   - 'codex-close'：关闭 Codex 时，新增 ≥ MIN_TURNS_CLOSE 条才写；
 *   - 'midrun'：Codex 一直开着，每 2 分钟检查一次，新增 ≥ MIN_TURNS_MIDRUN 条才写；
 *   - 'manual'：命令行手动触发，同样按 close 的门槛（--force 则无条件写）。
 *
 * @returns {{status: 'written'|'skipped'|'empty'|'dry-run', reason?: string, path?: string, text?: string}}
 */
async function runDiary(options = {}) {
  const {
    date,
    reason = 'manual',
    force = false,
    rebuild = false,
    dryRun = false,
    quiet = false,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = options;

  const key = date || dayKey();
  const say = (msg) => {
    if (!quiet) console.log(msg);
  };

  if (!rebuild && rebuildInProgress()) {
    say('[diary] 正在重建当天日记，本次跳过');
    return { status: 'skipped', reason: 'rebuilding' };
  }

  const { items: asks } = extractAsks(key);
  if (asks.length === 0) {
    say(`[diary] ${key} 没有 Codex 记录，跳过`);
    return { status: 'empty' };
  }

  const state = readState();
  // 重建：把已有文件留成备份，从零把当天所有会话重新扫一遍（用于补回历史遗漏）。
  if (rebuild && !dryRun) {
    fs.mkdirSync(DIARY_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(Date.now()));
    process.once('exit', () => {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    });
    const file = diaryPath(key);
    if (fs.existsSync(file)) {
      const stamp = new Date();
      const suffix = `${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}${pad2(stamp.getSeconds())}`;
      fs.renameSync(file, `${file}.bak-${suffix}`);
      say(`[diary] 旧文件已备份为 ${path.basename(file)}.bak-${suffix}`);
    }
    delete state[key];
    writeState(state);
  }
  // dry-run 只演算，不动磁盘
  const day = rebuild ? (dryRun ? {} : state[key] || {}) : state[key] || {};
  const lastTs = Number(day.lastTs) || 0;
  const fresh = asks.filter((a) => a.ts > lastTs);

  const queue = rebuild ? {} : readQueue();
  const queued = Array.isArray(queue[key]) ? queue[key] : [];
  const pending = dedupeItems([...queued, ...fresh]);
  const tier = pricingTier();
  const ignorePeak = process.env.DSH_DIARY_IGNORE_PEAK === '1';

  // 峰时：只把素材记下来排队，绝不调用模型；等谷时（或下次启动 Codex 且是谷时）再写。
  if (!rebuild && !dryRun && !ignorePeak && tier === 'peak') {
    if (pending.length) {
      queue[key] = pending;
      writeQueue(queue);
      say(`[diary] 峰时，先记下 ${pending.length} 条（其中排队 ${queued.length} 条），谷时再写`);
      if (reason === 'codex-close') await notifyPet('峰时先不写啦，谷时再补～');
      return { status: 'queued', pending: pending.length, tier };
    }
    say('[diary] 峰时且没有新素材，跳过');
    return { status: 'skipped', reason: 'peak-empty', tier };
  }

  const threshold = rebuild || force || queued.length ? 1 : reason === 'midrun' ? MIN_TURNS_MIDRUN : MIN_TURNS_CLOSE;

  /**
   * 心声线（私聊）单独一套节奏：只有它安静满 N 分钟，才把它的内容拿去写日记。
   * 其它对话完全不受影响 —— 它们的内容随时可以写。
   */
  const chatId = linkedSessionId();
  const chatIdleMs = Number(process.env.DSH_CHAT_IDLE_MINUTES || 10) * 60 * 1000;
  const cutoff = Date.now() - chatIdleMs;
  const isChat = (item) => Boolean(chatId && item.session === chatId);

  const chatPending = pending.filter(isChat);
  const blockedChat = chatPending.filter((p) => p.ts > cutoff);
  const ready = pending.filter((p) => !isChat(p) || p.ts <= cutoff);
  const chatReady = ready.filter(isChat);
  const otherReady = ready.filter((p) => !isChat(p));

  if (!rebuild && chatId) {
    // 私聊还在聊、而且没有别的素材可写：直接等
    if (blockedChat.length && otherReady.length === 0) {
      const last = blockedChat[blockedChat.length - 1].ts;
      const waitMin = Math.max(1, Math.ceil((chatIdleMs - (Date.now() - last)) / 60000));
      say(`[diary] 心声线还在聊，等安静 ${Math.round(chatIdleMs / 60000)} 分钟再写（约 ${waitMin} 分钟后）`);
      return { status: 'skipped', reason: 'chat-idle', waitMinutes: waitMin };
    }
  }

  const enough = force || rebuild || queued.length > 0 || otherReady.length >= threshold || chatReady.length > 0;
  if (!enough) {
    say(`[diary] ${key} 新增 ${otherReady.length} 条（私聊 ${chatReady.length} 条），未到 ${threshold} 条，先攒着`);
    return { status: 'skipped', reason: 'below-threshold', pending: otherReady.length, threshold };
  }

  const itemCap = rebuild ? Math.max(MAX_ITEMS, 120) : MAX_ITEMS;
  const shown = ready.length > itemCap ? ready.slice(-itemCap) : ready;
  // 重建当天时按"间隔 > 60 分钟"切成几段，一条日记对应一段，而不是把 49 条糊成一句。
  const segments = rebuild ? splitSegments(shown) : [shown];

  if (dryRun) {
    say(`[diary] 当前档位：${tier}（${tier === 'peak' ? '峰时不会调用模型' : '谷时'}），排队 ${queued.length} 条`);
    for (const seg of segments) {
      const span = seg.length > 1 ? `${seg[0].time}–${seg[seg.length - 1].time}` : seg[0].time;
      const prompt = buildPrompt(key, seg, ready.length > itemCap);
      say(`[diary] dry-run ${key} ${span}：${seg.length} 条，输入约 ${prompt.length} 字`);
      say('--- user ---');
      say(prompt);
    }
    return { status: 'dry-run' };
  }

  if (!acquireWriteLock()) {
    say('[diary] 另一个写入正在进行，跳过这一轮');
    return { status: 'skipped', reason: 'locked' };
  }
  try {
  const cfg = readAiConfig();
  const now = new Date();
  const history = Array.isArray(day.entries) ? day.entries.slice(-199) : [];
  let lastText = '';
  let lastTime = '';
  let totalIn = 0;
  let totalOut = 0;
  let count = 0;

  for (const seg of segments) {
    const prompt = buildPrompt(key, seg, ready.length > itemCap);
    const { text, usage } = await askModel(cfg, prompt, maxTokens);
    const lastMsg = seg[seg.length - 1];
    // 时间标签：重建用这段最后一条提问的时间；正常写入用当下的时间
    const time = rebuild
      ? lastMsg.time
      : `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const tokens = usage ? { in: usage.prompt_tokens, out: usage.completion_tokens } : null;
    if (usage) {
      totalIn += usage.prompt_tokens || 0;
      totalOut += usage.completion_tokens || 0;
    }
    count += seg.length;
    appendEntry(key, { time, text, count: seg.length, tokens, model: cfg.model });
    history.push({ time, count: seg.length, tokens });
    state[key] = {
      lastTs: Math.max(Number(day.lastTs) || 0, lastMsg.ts),
      lastWriteAt: Date.now(),
      model: cfg.model,
      entries: history,
    };
    writeState(state);
    say(`[diary] 写好 ${diaryPath(key)}（${time}，${seg.length} 条）`);
    say(text);
    lastText = text;
    lastTime = time;
  }

  writeIndex();
  if (!rebuild) {
    // 还在 10 分钟"热聊期"的私聊内容留着，下一轮安静后再写
    if (blockedChat.length) queue[key] = blockedChat;
    else delete queue[key];
    writeQueue(queue);
  }
  if (rebuild) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
  if (totalIn || totalOut) say(`[diary] tokens in=${totalIn} out=${totalOut}`);

  await notifyPet(`日记写好了～（${lastTime}）`);
  return { status: 'written', path: diaryPath(key), text: lastText, time: lastTime, count };
  } finally {
    releaseWriteLock();
  }
}

function listDiaries() {
  const entries = allEntries();
  if (!entries.length) {
    console.log('还没有日记');
    return;
  }
  for (const e of entries) {
    const tok = e.tokens ? ` · ${e.tokens.in}/${e.tokens.out} tok` : '';
    console.log(`${e.key} ${e.time}  ${e.text.slice(0, 56)}…  · ${e.count} 件${tok}`);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (flag('--list')) {
    listDiaries();
    process.exit(0);
  }

  if (flag('--view')) {
    writeIndex();
    console.log(`已重建 ${path.join(DIARY_DIR, 'viewer.html')}`);
    process.exit(0);
  }

  if (flag('--open')) {
    writeIndex();
    const viewer = path.join(DIARY_DIR, 'viewer.html');
    require('child_process').spawn('explorer.exe', [viewer], { detached: true, stdio: 'ignore' }).unref();
    console.log(`已打开 ${viewer}`);
    process.exit(0);
  }

  runDiary({
    date: value('--date'),
    force: flag('--force'),
    rebuild: flag('--rebuild'),
    dryRun: flag('--dry-run'),
    quiet: flag('--quiet'),
  })
    .then((r) => process.exit(r.status === 'written' || r.status === 'skipped' ? 0 : 0))
    .catch((err) => {
      console.error(`[diary] 失败：${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  runDiary,
  dayKey,
  extractAsks,
  listDiaries,
  pendingDates,
  pricingTier,
  allEntries,
  readState,
  readAiConfig,
  askModel,
};

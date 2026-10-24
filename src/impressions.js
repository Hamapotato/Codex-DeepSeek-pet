#!/usr/bin/env node
'use strict';

/**
 * 印象簿（impressions）— 大肥鱼眼里的你。
 *
 * 设计原则：**慢**。
 *   - 不急着下结论：要攒够很多日记/对话才第一次形成印象；
 *   - 之后每次只做小幅修正，旧的印象会一起喂回去；
 *   - 偶尔遇到很特别的细节，单独记进「特别的小事」，不参与性格结论。
 *
 * 素材用**已经压缩过的日记**（每条日记本身就概括了 3～15 条提问），所以很省：
 *   - 完整分析：最近 12 篇日记 + 上一版印象 → 输入约 1～2k token；
 *   - 细节捕捉：最近 2 篇日记 → 输入几百 token，输出 ≤2 条短句。
 *
 * 峰时不调用模型（和日记同一套规则），等谷时再算。
 *
 * 存储（全部本地）：
 *   impressions/profile.json   结构化印象
 *   impressions/profile.md     人读版
 *   impressions/viewer.html    阅读页（字体与余额气泡一致）
 *   impressions/.state.json    进度
 */

const fs = require('fs');
const path = require('path');

const { DSH_HOME } = require('./config');
const {
  allEntries,
  pricingTier,
  readAiConfig,
  askModel,
} = require('./diary');
const { fontDataUrl, FONT_FAMILY } = require('./diary-view');

const DIR = path.join(DSH_HOME, 'dsh-pet', 'impressions');
const PROFILE_JSON = path.join(DIR, 'profile.json');
const PROFILE_MD = path.join(DIR, 'profile.md');
const VIEWER = path.join(DIR, 'viewer.html');
const STATE_FILE = path.join(DIR, '.state.json');
const LOCK = path.join(DIR, '.write.lock');

// 第一次形成印象：要够多。之后每次更新：门槛低一些，但仍是"多篇"。
const FIRST_ENTRIES = Number(process.env.DSH_IMPRESSION_FIRST_ENTRIES || 8);
const FIRST_MESSAGES = Number(process.env.DSH_IMPRESSION_FIRST_MESSAGES || 150);
const NEXT_ENTRIES = Number(process.env.DSH_IMPRESSION_MIN_ENTRIES || 4);
const NEXT_MESSAGES = Number(process.env.DSH_IMPRESSION_MIN_MESSAGES || 80);
// 特别的小事：每多 2 篇日记就有机会补记一次（模型可以什么都不记）
const HIGHLIGHT_ENTRIES = Number(process.env.DSH_IMPRESSION_HIGHLIGHT_ENTRIES || 2);

const MAX_ENTRIES_IN_PROMPT = 12;
const MAX_HIGHLIGHTS = 10;
const MAX_TOKENS = Number(process.env.DSH_IMPRESSION_MAX_TOKENS || 800);

const PROFILE_PROMPT = [
  '你是「大肥鱼」，一只住在主人桌面上的蓝色胖鱼。下面是主人最近的日记（你自己写的）以及你之前的印象。',
  '请**谨慎地**更新你对主人的印象：证据不足就写「还不确定」，不要急着给人下定义。',
  '只输出一个 JSON 对象，不要 Markdown、不要解释：',
  '{"identity":"一句话说明主人的身份或在做的事，不超过 30 字；没把握就写还不确定",',
  '"traits":["0-5 个性格关键词，每个不超过 8 字；没把握就少写或不写"],',
  '"habits":["0-4 条习惯或偏好，每条不超过 20 字"],',
  '"highlights":["0-2 条这次发现的、很特别的小细节，每条不超过 24 字"],',
  '"note":"你想对主人说的一句话，不超过 40 字"}',
  '口吻自然，可以带点你自己的情绪；不要编造。',
].join('');

const HIGHLIGHT_PROMPT = [
  '你是「大肥鱼」。下面是主人最近两篇日记。',
  '只挑**很特别、值得记住的小细节**（习惯、怪癖、偏好、说过的话），普通日常不要记。',
  '只输出 JSON：{"highlights":["0-2 条，每条不超过 24 字，没有就返回空数组"]}',
].join('');

const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

const readState = () => readJson(STATE_FILE, {});
const writeState = (state) => writeJson(STATE_FILE, state);

function acquireLock() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > 5 * 60 * 1000) {
        fs.unlinkSync(LOCK);
        fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch {}
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK);
  } catch {}
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

/** 已写日记的总量：篇数 + 覆盖的提问数（每条日记头部记了条数）。 */
function totals(entries) {
  return {
    entries: entries.length,
    messages: entries.reduce((sum, e) => sum + (Number(e.count) || 0), 0),
  };
}

function diaryText(entries) {
  return entries.map((e) => `- ${e.key} ${e.time}：${e.text}`).join('\n');
}

function confidenceOf(t) {
  if (t.entries >= 20 || t.messages >= 400) return 'high';
  if (t.entries >= 12 || t.messages >= 220) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CONF_TEXT = {
  low: '初步印象 · 还在慢慢了解你',
  medium: '有点了解了 · 印象还会变',
  high: '相处挺久了 · 印象比较稳定',
};

function renderViewer(profile, progress) {
  const font = fontDataUrl();
  const chips = (list, cls = 'chip') =>
    list && list.length
      ? `<div class="chips">${list.map((x) => `<span class="${cls}">${esc(x)}</span>`).join('')}</div>`
      : '';

  const observed = profile
    ? `${profile.basedOnDiary} 篇日记 / ${profile.basedOnMessages} 条对话`
    : '暂时还没有结论';

  const body = profile
    ? `
    <section class="card">
      <div class="label">你是</div>
      <div class="value">${esc(profile.identity || '还不确定')}</div>
    </section>

    <section class="card">
      <div class="label">性格</div>
      ${chips(profile.traits) || '<div class="muted">还看不出来，慢慢来</div>'}
    </section>

    <section class="card">
      <div class="label">习惯 / 偏好</div>
      ${
        profile.habits && profile.habits.length
          ? `<div class="habits">${profile.habits
              .map((h) => `<div><span class="dot">◆</span>${esc(h)}</div>`)
              .join('')}</div>`
          : '<div class="muted">还看不出来，慢慢来</div>'
      }
    </section>

    ${
      profile.highlights && profile.highlights.length
        ? `<section class="card">
      <div class="label">特别的小事</div>
      <div class="habits">${profile.highlights
        .map((h) => `<div><span class="dot gold">✦</span>${esc(h)}</div>`)
        .join('')}</div>
    </section>`
        : ''
    }

    <section class="card">
      <div class="label">想对你说</div>
      <div class="quote">${esc(profile.note || '……')}</div>
    </section>`
    : `
    <section class="card observing">
      <div class="label">还在观察</div>
      <div class="value">我还不打算这么早给你下结论。</div>
      <p class="muted">已经看了 <b>${progress.entries}</b> 篇日记、约 <b>${progress.messages}</b> 条对话；
      攒到 ${FIRST_ENTRIES} 篇或约 ${FIRST_MESSAGES} 条，我再试着说说你是个什么样的人。</p>
    </section>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大肥鱼眼里的你</title>
<style>
  ${font ? `@font-face{font-family:'ShangshouSoftCandy';src:url('${font}') format('truetype');font-display:swap;}` : ''}
  :root{--ink:#2b2b2b;--ink-soft:#6b6259;--green:#2e9e4f;--gold:#c9a227}
  *{box-sizing:border-box}
  body{
    margin:0;padding:48px 20px 64px;color:var(--ink);
    font-family:${FONT_FAMILY};
    background:radial-gradient(1100px 460px at 50% -220px, rgba(46,158,79,.10), transparent 70%),
               linear-gradient(180deg,#fdfaf5 0%,#f6efe5 100%);
    min-height:100vh;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;
  }
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:34px;margin:0 0 10px;display:flex;align-items:center;gap:10px}
  .sub{color:var(--ink-soft);font-size:15px;margin-bottom:30px}
  .card{background:#fff;border-radius:20px;padding:22px 24px;margin-bottom:18px;
    box-shadow:0 1px 2px rgba(43,43,43,.04),0 10px 30px rgba(43,43,43,.07)}
  .label{font-size:14px;color:#9d9287;letter-spacing:.4px;margin-bottom:10px}
  .value{font-size:20px;line-height:1.7}
  .chips{display:flex;flex-wrap:wrap;gap:10px}
  .chip{background:rgba(46,158,79,.12);color:#2f7a4a;border-radius:999px;padding:5px 14px;font-size:16px}
  .habits{display:flex;flex-direction:column;gap:8px;font-size:17px;line-height:1.7}
  .dot{color:var(--green);margin-right:8px}
  .dot.gold{color:var(--gold)}
  .quote{font-size:18px;line-height:1.9;color:#3a3a3a}
  .muted{color:#a1978c;font-size:15px;margin:8px 0 0;line-height:1.8}
  .muted b{color:var(--green)}
  footer{margin-top:30px;text-align:center;color:#b0a599;font-size:15px}
  @media (prefers-color-scheme: dark){
    :root{--ink:#ece7e0;--ink-soft:#a79e94}
    body{background:radial-gradient(1100px 460px at 50% -220px, rgba(46,158,79,.14), transparent 70%),linear-gradient(180deg,#1b1917,#14120f)}
    .card{background:#242120;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    .quote{color:#d9d2ca}
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1><span>🐟</span>大肥鱼眼里的你</h1>
    <div class="sub">${observed}${profile && profile.confidence ? ` · ${CONF_TEXT[profile.confidence] || ''}` : ''}</div>
    ${body}
    <footer>这些只是大肥鱼的观察，随时会变 · 只存在本机</footer>
  </div>
</body>
</html>`;
}

function writeProfile(profile, progress) {
  fs.mkdirSync(DIR, { recursive: true });
  writeJson(PROFILE_JSON, profile);
  fs.writeFileSync(VIEWER, renderViewer(profile, progress), 'utf8');
  if (!profile) {
    fs.writeFileSync(PROFILE_MD, `# 大肥鱼眼里的你\n\n还在观察中：已看 ${progress.entries} 篇日记 / 约 ${progress.messages} 条对话。\n`, 'utf8');
    return;
  }
  fs.writeFileSync(
    PROFILE_MD,
    [
      '# 大肥鱼眼里的你',
      '',
      `> 更新于 ${profile.updatedAt} · 基于 ${profile.basedOnDiary} 篇日记 / ${profile.basedOnMessages} 条对话 · ${CONF_TEXT[profile.confidence] || ''}`,
      '',
      '## 你是',
      '',
      profile.identity,
      '',
      '## 性格',
      '',
      ...(profile.traits || []).map((t) => `- ${t}`),
      '',
      '## 习惯 / 偏好',
      '',
      ...(profile.habits || []).map((h) => `- ${h}`),
      '',
      '## 特别的小事',
      '',
      ...(profile.highlights || []).map((h) => `- ${h}`),
      '',
      '## 想对你说',
      '',
      profile.note,
      '',
    ].join('\n'),
    'utf8',
  );
}

/** 没有结论时也写一份"还在观察"的页面，让菜单点开有东西看。 */
function writePlaceholder(entries) {
  writeProfile(null, totals(entries));
  try {
    fs.unlinkSync(PROFILE_JSON);
  } catch {}
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runImpressions(options = {}) {
  const { force = false, dryRun = false, quiet = false } = options;
  const say = (msg) => {
    if (!quiet) console.log(msg);
  };

  const entries = allEntries();
  const stats = totals(entries);
  const state = readState();
  const profile = readJson(PROFILE_JSON, null);

  const entryGain = stats.entries - (Number(state.lastEntryCount) || 0);
  const messageGain = stats.messages - (Number(state.lastMessageCount) || 0);

  const due = force
    ? true
    : profile
      ? entryGain >= NEXT_ENTRIES || messageGain >= NEXT_MESSAGES
      : stats.entries >= FIRST_ENTRIES || stats.messages >= FIRST_MESSAGES;

  if (!due) {
    if (!profile) writePlaceholder(entries);
    say(
      profile
        ? `[印象] 还不够更新：新增 ${entryGain}/${NEXT_ENTRIES} 篇、${messageGain}/${NEXT_MESSAGES} 条`
        : `[印象] 还在观察：已看 ${stats.entries}/${FIRST_ENTRIES} 篇、${stats.messages}/${FIRST_MESSAGES} 条`,
    );
    return { status: 'skipped', reason: 'below-threshold', stats };
  }

  const tier = pricingTier();
  if (!dryRun && tier === 'peak') {
    say('[印象] 峰时不调用模型，等谷时再算');
    return { status: 'skipped', reason: 'peak', tier };
  }

  const recent = entries.slice(0, MAX_ENTRIES_IN_PROMPT);
  const prompt = [
    `累计证据：${stats.entries} 篇日记、约 ${stats.messages} 条对话。`,
    profile ? `上一版印象：${JSON.stringify({ identity: profile.identity, traits: profile.traits, habits: profile.habits, highlights: profile.highlights })}\n` : '',
    `最近日记：\n${diaryText(recent)}`,
  ]
    .filter(Boolean)
    .join('\n');

  if (dryRun) {
    say(`[印象] dry-run：档位 ${tier}，素材 ${prompt.length} 字`);
    say(prompt);
    return { status: 'dry-run' };
  }

  if (!acquireLock()) {
    say('[印象] 另一个分析正在进行，跳过');
    return { status: 'skipped', reason: 'locked' };
  }
  try {
    const cfg = readAiConfig();
    const { text, usage } = await askModel(cfg, prompt, MAX_TOKENS, PROFILE_PROMPT);
    const j = parseJsonLoose(text) || {};

    const mergedHighlights = [
      ...(profile && Array.isArray(profile.highlights) ? profile.highlights : []),
      ...arr(j.highlights),
    ].filter((v, i, a) => a.indexOf(v) === i).slice(-MAX_HIGHLIGHTS);

    const next = {
      updatedAt: new Date().toISOString(),
      basedOnDiary: stats.entries,
      basedOnMessages: stats.messages,
      confidence: confidenceOf(stats),
      model: cfg.model,
      tokens: usage ? { in: usage.prompt_tokens, out: usage.completion_tokens } : null,
      identity: String(j.identity || (profile && profile.identity) || '还不确定'),
      traits: arr(j.traits).slice(0, 5),
      habits: arr(j.habits).slice(0, 4),
      highlights: mergedHighlights,
      note: String(j.note || (profile && profile.note) || ''),
    };

    writeProfile(next, stats);
    writeState({ lastEntryCount: stats.entries, lastMessageCount: stats.messages, lastAt: Date.now() });
    say(`[印象] 已更新（${stats.entries} 篇 / ${stats.messages} 条，置信度 ${next.confidence}）`);
    say(`${next.identity} | ${next.traits.join('、')}`);
    if (usage) say(`[印象] tokens in=${usage.prompt_tokens} out=${usage.completion_tokens}`);
    return { status: 'written', profile: next };
  } finally {
    releaseLock();
  }
}

/**
 * 只捕捉"特别的小事"：每多 HIGHLIGHT_ENTRIES 篇日记跑一次，
 * 输入只有最近两篇，输出 0～2 条，模型可以什么都不记。
 */
async function captureHighlights(options = {}) {
  const { quiet = true, dryRun = false } = options;
  const entries = allEntries();
  const state = readState();
  const profile = readJson(PROFILE_JSON, null);
  const gain = entries.length - (Number(state.lastHighlightEntryCount) || 0);
  if (gain < HIGHLIGHT_ENTRIES) return { status: 'skipped', reason: 'below-threshold' };
  if (pricingTier() === 'peak' && !dryRun) return { status: 'skipped', reason: 'peak' };

  const recent = entries.slice(0, 2);
  const prompt = `最近两篇日记：\n${diaryText(recent)}`;
  if (dryRun) {
    console.log(`[印象] highlight dry-run：${prompt.length} 字`);
    return { status: 'dry-run' };
  }
  if (!acquireLock()) return { status: 'skipped', reason: 'locked' };
  try {
    const cfg = readAiConfig();
    const { text, usage } = await askModel(cfg, prompt, 400, HIGHLIGHT_PROMPT);
    const j = parseJsonLoose(text) || {};
    const fresh = arr(j.highlights).slice(0, 2);
    if (fresh.length) {
      const base = profile || {};
      const merged = [
        ...(Array.isArray(base.highlights) ? base.highlights : []),
        ...fresh,
      ].filter((v, i, a) => a.indexOf(v) === i).slice(-MAX_HIGHLIGHTS);
      const stats = totals(entries);
      writeProfile(
        {
          ...base,
          updatedAt: base.updatedAt || new Date().toISOString(),
          basedOnDiary: base.basedOnDiary ?? stats.entries,
          basedOnMessages: base.basedOnMessages ?? stats.messages,
          confidence: base.confidence || confidenceOf(stats),
          highlights: merged,
          identity: base.identity || '还不确定',
          traits: base.traits || [],
          habits: base.habits || [],
          note: base.note || '',
        },
        stats,
      );
    }
    writeState({ ...state, lastHighlightEntryCount: entries.length });
    if (!quiet) console.log(`[印象] 细节 +${fresh.length}`);
    return { status: fresh.length ? 'written' : 'skipped', highlights: fresh, usage };
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  if (flag('--view')) {
    const p = readJson(PROFILE_JSON, null);
    const entries = allEntries();
    if (p) writeProfile(p, totals(entries));
    else writePlaceholder(entries);
    console.log(`已重建 ${VIEWER}`);
    process.exit(0);
  }
  if (flag('--open')) {
    const p = readJson(PROFILE_JSON, null);
    const entries = allEntries();
    if (p) writeProfile(p, totals(entries));
    else writePlaceholder(entries);
    require('child_process').spawn('explorer.exe', [VIEWER], { detached: true, stdio: 'ignore' }).unref();
    console.log(`已打开 ${VIEWER}`);
    process.exit(0);
  }
  (async () => {
    await captureHighlights({ quiet: flag('--quiet'), dryRun: flag('--dry-run') });
    await runImpressions({ force: flag('--force'), dryRun: flag('--dry-run'), quiet: flag('--quiet') });
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[印象] 失败：${err.message}`);
      process.exit(1);
    });
}

module.exports = { runImpressions, captureHighlights, DIR, VIEWER, PROFILE_JSON };

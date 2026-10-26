#!/usr/bin/env node
'use strict';

/**
 * 小鱼游记 —— 大肥鱼每天自己出去逛一次。
 *
 * 「真的出去」：不是让模型编，而是真的发 HTTP 请求：
 *   - search  ：Bing 搜索结果 + 打开第一条网页，读真实内容
 *   - book    ：Project Gutenberg 随机找一本书，读简介/原文片段
 *   - weather ：南京实时天气（Open-Meteo）
 *   - image   ：Bing 图片搜索，下载一张到 tour/images/（记录标题与来源）
 * 然后由模型据此写一段 200～400 字的游记，作为「游记」标签追加进当天的日记。
 *
 * 每天一次；峰时不跑；所有素材与结果都只存在本地。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const { DSH_HOME } = require('./config');
const { readAiConfig, askModel, pricingTier, dayKey } = require('./diary');
const { appendEntry, writeIndex, notifyPet } = require('./diary');

const DIR = path.join(DSH_HOME, 'dsh-pet', 'tour');
const IMG_DIR = path.join(DIR, 'images');
const STATE_FILE = path.join(DIR, '.state.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-pet-tour/1.0';

const PLAN_PROMPT = [
  '你是「大肥鱼」，一只住在主人桌面上的蓝色胖鱼，每天可以出去玩一次。',
  '今天只去**一个**地方，看点文字或图片就回来。从下面四种里选一个，写成 JSON，不要解释：',
  '{"kind":"post","query":"想看的帖子主题，例如 雪山 / 动漫 / 机械臂"}',
  '{"kind":"search","query":"想搜的主题（中文或英文，简短）"}',
  '{"kind":"book","query":"想找的书或主题，例如 ancient chinese poetry / robot novel"}',
  '{"kind":"weather","city":"Nanjing"}',
  '{"kind":"image","query":"想看的图片主题，例如 雪山 / 动漫场景 / 深海生物"}',
  '挑你**真的好奇**的，别每次都选同一个；可以跟最近日记里主人做的事有关，也可以完全无关。',
  '想看什么都可以：雪山、动漫、动物、建筑、天文…一次只看一种，别贪多。',
  '优先选 post（图文帖子），那最像真的出门逛。',
].join('');

const LOG_PROMPT = [
  '你是「大肥鱼」。下面是你今天出门看到/读到的**真实素材**。',
  '写一段 200～400 字的游记：第一人称，口语、可爱、有点懒散，写你看到了什么、想到了什么，',
  '可以吐槽、可以惊叹、可以联想到主人。不要编造素材里没有的事实；不要写标题或 Markdown。',
  '如果素材里有「配图我看了」的描述，务必写一两句你看到的画面，别只复述文字。',
].join('');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function get(url, { binary = false, timeout = 12000, maxBytes = 2_000_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        timeout,
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), { binary, timeout, maxBytes }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(binary ? buf : buf.toString('utf8'));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const stripTags = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 让模型真的「看」一张图：把本地图片作为 vision 输入发过去。 */
function mimeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  return 'image/jpeg';
}

function describeImages(cfg, images, query) {
  const parts = [{ type: 'text', text: `我找到一篇关于「${query}」的帖子，里面有 ${images.length} 张图。你看到了什么？各用两三句说，具体一点。` }];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${mimeOf(img)};base64,${img.toString('base64')}` } });
  }
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: 900,
    stream: false,
    messages: [
      {
        role: 'system',
        content: '你是「大肥鱼」，一只好奇的蓝色胖鱼。用中文描述你看到的画面，3～5 句，具体、生动，不要编造看不见的东西。',
      },
      { role: 'user', content: parts },
    ],
  });

  return new Promise((resolve) => {
    const u = new URL(String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions');
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        timeout: Number(cfg.timeoutMs) || 60000,
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (t += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(t);
            resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
          } catch {
            resolve('');
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// 四种玩法
// ---------------------------------------------------------------------------

async function doSearch(query) {
  const html = await get(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`);
  const results = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < 4) {
    results.push({ url: m[1], title: stripTags(m[2]), snippet: stripTags(m[3] || '') });
  }
  if (!results.length) throw new Error('bing 没解析出结果');

  // 打开第一条，读真实正文（失败也不影响）
  let page = null;
  try {
    const html2 = await get(results[0].url, { maxBytes: 3_000_000 });
    page = stripTags(html2).slice(0, 1500);
  } catch {}

  return {
    kind: 'search',
    title: `搜了「${query}」`,
    sources: results.map((r) => `${r.title} — ${r.url}`),
    material: [
      `搜索词：${query}`,
      ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`),
      page ? `\n我点开第一篇，里面写着：${page.slice(0, 1200)}` : '',
    ].join('\n'),
  };
}

// ---- B 站专栏（图文帖子）--------------------------------------------------

let biliCookie = '';

async function biliCookieHeader() {
  if (biliCookie) return biliCookie;
  try {
    const r = await new Promise((resolve) => {
      const req = https.get('https://www.bilibili.com/', { timeout: 10000, headers: { 'user-agent': UA } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['set-cookie'] || []));
      });
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
    });
    biliCookie = r.map((c) => c.split(';')[0]).join('; ');
  } catch {}
  return biliCookie;
}

async function biliGet(url, { binary = false } = {}) {
  const cookie = await biliCookieHeader();
  return get(url, { binary, timeout: 15000, headers: { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie } });
}

/** 读一篇 B 站专栏：标题 + 正文 + 配图（图会真的看）。 */
async function doPost(query, cfg) {
  const searchRaw = await biliGet(
    `https://api.bilibili.com/x/web-interface/search/type?search_type=article&keyword=${encodeURIComponent(query)}`,
  );
  const sj = JSON.parse(searchRaw);
  const list = (sj.data && sj.data.result) || [];
  if (!list.length) throw new Error('专栏没搜到结果');

  // 搜索结果里有些是空壳/无权限，挑一篇正文够长的（最多试 6 篇）
  const order = list.slice(0, 6).map((_, i) => i);
  order.sort(() => Math.random() - 0.5);
  let d = null;
  let html = '';
  let pick = null;
  for (const i of order) {
    const cand = list[i];
    try {
      const viewRaw = await biliGet(`https://api.bilibili.com/x/article/view?id=${cand.id}`);
      const vj = JSON.parse(viewRaw);
      const content = String((vj.data && vj.data.content) || '');
      if (stripTags(content).length < 300) continue;
      d = vj.data;
      html = content;
      pick = cand;
      break;
    } catch {}
  }
  if (!d) throw new Error('专栏都没有可用正文');

  const text = stripTags(html).slice(0, 1600);
  const imgUrls = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)]
    .map((m) => (m[1].startsWith('//') ? 'https:' + m[1] : m[1]))
    .slice(0, 2);
  if (!imgUrls.length && Array.isArray(d.image_urls) && d.image_urls.length) {
    imgUrls.push(...d.image_urls.slice(0, 2).map((u) => (u.startsWith('//') ? 'https:' + u : u)));
  }

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const saved = [];
  const buffers = [];
  for (let i = 0; i < imgUrls.length; i++) {
    try {
      const buf = await get(imgUrls[i], { binary: true, timeout: 15000, maxBytes: 5_000_000 });
      if (buf.length > 5000) {
        const target = path.join(IMG_DIR, `${dayKey()}-${i + 1}.jpg`);
        fs.writeFileSync(target, buf);
        saved.push(target);
        buffers.push(buf);
      }
    } catch {}
  }
  const seen = cfg && buffers.length ? await describeImages(cfg, buffers, query) : '';

  return {
    kind: 'post',
    title: `读了一篇专栏《${stripTags(d.title || pick.title || query).slice(0, 40)}》`,
    sources: [`https://www.bilibili.com/read/cv${pick.id}`],
    images: saved,
    seen,
    material: [
      `标题：${d.title || pick.title}`,
      `正文（节选）：${text}`,
      seen ? `\n配图我看了：${seen}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function doBook(query) {
  const html = await get(`https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query || 'classic novel')}`);
  const ids = [...html.matchAll(/href="\/ebooks\/(\d+)"/g)].map((m) => m[1]);
  if (!ids.length) throw new Error('gutenberg 没找到书');
  const pick = ids[crypto.randomInt(ids.length)];
  const bookHtml = await get(`https://www.gutenberg.org/ebooks/${pick}`);
  const title = (bookHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const summary = (bookHtml.match(/<div class="summary-text">([\s\S]*?)<\/div>/) || [])[1];
  return {
    kind: 'book',
    title: `读了《${stripTags(title || '一本旧书')}》`,
    sources: [`https://www.gutenberg.org/ebooks/${pick}`],
    material: [
      `书名：${stripTags(title || '')}`,
      `链接：https://www.gutenberg.org/ebooks/${pick}`,
      `简介：${stripTags(summary || bookHtml).slice(0, 1200)}`,
    ].join('\n'),
  };
}

async function doWeather() {
  const raw = await get('https://api.open-meteo.com/v1/forecast?latitude=32.06&longitude=118.79&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai&forecast_days=1');
  const j = JSON.parse(raw);
  const cur = j.current || {};
  const day = (j.daily && j.daily.temperature_2m_max && j.daily.temperature_2m_max[0]) || null;
  return {
    kind: 'weather',
    title: '出门看了天气',
    sources: ['https://open-meteo.com/'],
    material: `南京此刻 ${cur.temperature_2m}°C，风速 ${cur.wind_speed_10m} km/h，天气代码 ${cur.weather_code}；今天最高 ${day}°C。`,
  };
}

async function doImage(query, cfg) {
  const html = await get(`https://cn.bing.com/images/search?q=${encodeURIComponent(query)}`);
  const urls = [...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g)].map((m) => m[1]).slice(0, 5);
  if (!urls.length) throw new Error('bing 图片没解析出结果');
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const target = path.join(IMG_DIR, `${dayKey()}.jpg`);
  for (const u of urls) {
    try {
      const buf = await get(u, { binary: true, timeout: 15000, maxBytes: 4_000_000 });
      if (buf.length > 5000) {
        fs.writeFileSync(target, buf);
        const seen = cfg ? await describeImages(cfg, [buf], query) : '';
        return {
          kind: 'image',
          title: `看了「${query}」的图片`,
          sources: [u],
          image: target,
          material: [
            `我在网上翻到一张关于「${query}」的图片，保存在本地：${target}（来源 ${u}，${Math.round(buf.length / 1024)} KB）。`,
            seen ? `我真的看了这张图，画面是这样的：${seen}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          seen,
        };
      }
    } catch {}
  }
  throw new Error('图片都下载失败');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};

const writeState = (s) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
};

async function runTour({ force = false, dryRun = false, quiet = false, plan: forcedPlan = null } = {}) {
  const say = (m) => {
    if (!quiet) console.log(m);
  };
  const today = dayKey();
  const state = readState();
  if (!force && state.lastDate === today) {
    say('[游记] 今天已经出去过了');
    return { status: 'skipped', reason: 'done-today' };
  }
  if (!dryRun && !force && pricingTier() === 'peak') {
    say('[游记] 峰时不出门，等谷时');
    return { status: 'skipped', reason: 'peak' };
  }

  const cfg = readAiConfig();
  // 1) 决定去哪
  let plan = forcedPlan || { kind: 'search', query: '机器狗 四足机器人 最新' };
  if (forcedPlan) {
    say(`[游记] 指定玩法：${plan.kind} ${plan.query || plan.city || ''}`);
  } else try {
    const { text } = await askModel(cfg, '选一个今天想去的玩法。', 800, PLAN_PROMPT);
    const j = JSON.parse(String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    if (['search', 'book', 'weather', 'image'].includes(j.kind)) plan = j;
  } catch (err) {
    say('[游记] 计划失败，用默认：' + err.message);
  }
  say(`[游记] 今天想去：${plan.kind} ${plan.query || plan.city || ''}`);

  if (dryRun) return { status: 'dry-run', plan };

  // 2) 真的出去
  let trip;
  try {
    if (plan.kind === 'post') {
      // 专栏拿不到正文就退回普通搜索，别硬写一篇空游记
      try {
        trip = await doPost(plan.query, cfg);
      } catch (err) {
        say(`[游记] 专栏不可用（${err.message}），改去网页搜索`);
        trip = await doSearch(plan.query);
      }
    }
    else if (plan.kind === 'book') trip = await doBook(plan.query);
    else if (plan.kind === 'weather') trip = await doWeather();
    else if (plan.kind === 'image') trip = await doImage(plan.query, cfg);
    else trip = await doSearch(plan.query);
  } catch (err) {
    say('[游记] 出门失败：' + err.message);
    return { status: 'error', error: err.message };
  }
  say(`[游记] ${trip.title}`);

  // 3) 写游记
  let log = '';
  try {
    const { text } = await askModel(cfg, trip.material, 3000, LOG_PROMPT);
    log = String(text).trim();
  } catch (err) {
    say('[游记] 写游记失败：' + err.message);
    return { status: 'error', error: err.message };
  }

  // 4) 落盘：单独一份 + 追加进当天日记（带「游记」标签）
  fs.mkdirSync(DIR, { recursive: true });
  const md = [
    `# 小鱼游记 · ${today}`,
    '',
    `## ${trip.title}`,
    '',
    log,
    '',
    '## 素材来源',
    '',
    ...trip.sources.map((s) => `- ${s}`),
    trip.image ? `\n图片：${trip.image}` : '',
    trip.images && trip.images.length ? `\n配图：${trip.images.join('\n')}` : '',
    trip.seen ? `\n## 配图里看到\n\n${trip.seen}` : '',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DIR, `${today}.md`), md, 'utf8');

  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  appendEntry(today, { time, text: log, count: 0, tokens: null, model: cfg.model, tag: '🐟 游记' });
  writeIndex();
  writeState({ lastDate: today, lastAt: now.toISOString(), kind: trip.kind, title: trip.title });

  await notifyPet(`我出去玩啦～今天${trip.title}`);
  say(`[游记] 已写入 ${path.join(DIR, `${today}.md`)}`);
  return { status: 'written', trip, log, file: path.join(DIR, `${today}.md`) };
}

module.exports = { runTour, DIR };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const kind = val('--kind');
  const query = val('--query');
  const plan = kind ? { kind, query: query || '雪山' } : null;
  runTour({
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    quiet: argv.includes('--quiet'),
    plan,
  })
    .then((r) => {
      if (r.status === 'written') console.log(r.log);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[游记] 失败：' + e.message);
      process.exit(1);
    });
}

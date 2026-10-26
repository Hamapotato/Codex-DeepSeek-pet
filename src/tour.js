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
  '从下面四种玩法里选一个，写成 JSON，不要解释：',
  '{"kind":"search","query":"想搜的主题（中文或英文，简短）"}',
  '{"kind":"book","query":"想找的书或主题，例如 ancient chinese poetry / robot novel"}',
  '{"kind":"weather","city":"Nanjing"}',
  '{"kind":"image","query":"想看的图片主题"}',
  '挑你**真的好奇**的，别每次都选同一个；可以跟最近日记里主人做的事有关，也可以完全无关。',
].join('');

const LOG_PROMPT = [
  '你是「大肥鱼」。下面是你今天出门看到/读到的**真实素材**。',
  '写一段 200～400 字的游记：第一人称，口语、可爱、有点懒散，写你看到了什么、想到了什么，',
  '可以吐槽、可以惊叹、可以联想到主人。不要编造素材里没有的事实；不要写标题或 Markdown。',
].join('');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function get(url, { binary = false, timeout = 12000, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      { hostname: u.hostname, path: u.pathname + u.search, timeout, headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } },
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

async function doImage(query) {
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
        return {
          kind: 'image',
          title: `看了「${query}」的图片`,
          sources: [u],
          image: target,
          material: `我在网上翻到一张关于「${query}」的图片，保存在本地：${target}（来源 ${u}）。图片文件 ${Math.round(buf.length / 1024)} KB。`,
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

async function runTour({ force = false, dryRun = false, quiet = false } = {}) {
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
  let plan = { kind: 'search', query: '机器狗 四足机器人 最新' };
  try {
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
    if (plan.kind === 'book') trip = await doBook(plan.query);
    else if (plan.kind === 'weather') trip = await doWeather();
    else if (plan.kind === 'image') trip = await doImage(plan.query);
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
  runTour({ force: argv.includes('--force'), dryRun: argv.includes('--dry-run'), quiet: argv.includes('--quiet') })
    .then((r) => {
      if (r.status === 'written') console.log(r.log);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[游记] 失败：' + e.message);
      process.exit(1);
    });
}

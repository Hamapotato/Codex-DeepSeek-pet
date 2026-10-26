'use strict';

/**
 * 日记阅读页（viewer.html）的渲染。
 *
 * 纯字符串拼装：把 [{ key, time, text, count, tokens }] 变成一张静态 HTML。
 * 字体与余额气泡一致——从 dsh-pet 包里把「上首软糖体」复制到 diary/fonts/，
 * 再用相对路径 @font-face 引用（复制失败就丢给后备字体栈，不影响页面）。
 */

const fs = require('fs');
const path = require('path');
const { DSH_HOME } = require('./config');

/** 余额气泡同款字体：上首软糖体。复制到 diary/fonts 下，阅读页用相对路径引用。 */
const FONT_SOURCE = path.join(
  DSH_HOME,
  'profiles',
  'desktop',
  'node_modules',
  'dsh-pet',
  'assets',
  'fonts',
  '上首软糖体.ttf',
);
const FONT_NAME = '上首软糖体.ttf';
const FONT_FAMILY =
  "'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif";

/**
 * 把字体读成 data: URL 内联进页面。
 *
 * 为什么不用相对路径：viewer.html 是 file:// 打开的，Chromium 对 file:// 页面的
 * 本地字体加载时灵时不灵，一旦失败就悄悄回退到「幼圆/微软雅黑」，跟余额气泡对不上。
 * 内联是唯一 100% 保证一致的做法（4 MB 字体 → ~5 MB HTML，本地打开毫无压力）。
 */
let cachedFontUrl = null;
function fontDataUrl() {
  if (cachedFontUrl !== null) return cachedFontUrl;
  try {
    const buf = fs.readFileSync(FONT_SOURCE);
    cachedFontUrl = `data:font/ttf;base64,${buf.toString('base64')}`;
  } catch {
    cachedFontUrl = '';
  }
  return cachedFontUrl;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 生成 diary/viewer.html：菜单里「查看日记」打开的就是它。 */
function writeViewer(entries, diaryDir) {
  const fontHref = fontDataUrl();
  const cards = entries
    .map((e) => {
      const [y, m, d] = e.key.split('-');
      const weekday = WEEKDAYS[new Date(Number(y), Number(m) - 1, Number(d)).getDay()] || '';
      const meta = [];
      if (e.count) meta.push(`${e.count} 件事`);
      if (e.tokens) meta.push(`${e.tokens.in + e.tokens.out} tokens`);
      return `
      <article class="card">
        <div class="card-head">
          <time datetime="${e.key}"><span class="day">${Number(d)}</span><span class="ym">${y}.${m}</span></time>
          <span class="chip">${weekday}</span>
          <span class="chip time">${e.time}</span>
          ${e.tag ? `<span class="chip tag">${escapeHtml(e.tag)}</span>` : ''}
        </div>
        <p class="text">${escapeHtml(e.text)}</p>
        ${meta.length ? `<div class="meta">${escapeHtml(meta.join(' · '))}</div>` : ''}
      </article>`;
    })
    .join('\n');

  const count = entries.length;
  const latest = count ? `${entries[0].key} ${entries[0].time}` : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大肥鱼的日记</title>
<style>
  ${fontHref ? `@font-face{font-family:'ShangshouSoftCandy';src:url('${fontHref}') format('truetype');font-display:swap;}` : ''}
  :root{
    --ink:#2b2b2b; --ink-soft:#6b6259; --line:rgba(43,43,43,.08);
    --paper:#fdfaf5; --card:#ffffff; --green:#2e9e4f; --gold:#c9a227;
  }
  *{box-sizing:border-box}
  body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:geometricPrecision}
  body{
    margin:0; padding:48px 20px 72px;
    font-family:${FONT_FAMILY};
    color:var(--ink);
    background:
      radial-gradient(1100px 460px at 50% -220px, rgba(46,158,79,.10), transparent 70%),
      linear-gradient(180deg,#fdfaf5 0%,#f6efe5 100%);
    min-height:100vh;
  }
  .wrap{max-width:720px;margin:0 auto}
  header{margin-bottom:34px}
  h1{
    font-size:34px;margin:0 0 10px;font-weight:700;letter-spacing:.5px;
    display:flex;align-items:center;gap:10px;
  }
  h1 .fish{font-size:26px;transform:translateY(-2px)}
  .sub{color:var(--ink-soft);font-size:15px;letter-spacing:.3px}
  .sub b{color:var(--green);font-weight:700}
  .timeline{position:relative;padding-left:26px}
  .timeline::before{
    content:'';position:absolute;left:7px;top:6px;bottom:6px;width:2px;
    background:linear-gradient(180deg,rgba(46,158,79,.35),rgba(201,162,39,.18),transparent);
    border-radius:2px;
  }
  .card{
    position:relative;background:var(--card);border-radius:20px;
    padding:22px 24px 20px;margin-bottom:18px;
    box-shadow:0 1px 2px rgba(43,43,43,.04),0 10px 30px rgba(43,43,43,.07);
    border:1px solid rgba(255,255,255,.8);
    transition:transform .18s ease, box-shadow .18s ease;
  }
  .card::before{
    content:'';position:absolute;left:-26px;top:30px;width:12px;height:12px;border-radius:50%;
    background:#fff;border:3px solid var(--green);box-shadow:0 0 0 3px rgba(46,158,79,.10);
  }
  .card:hover{transform:translateY(-2px);box-shadow:0 2px 4px rgba(43,43,43,.05),0 16px 38px rgba(43,43,43,.10)}
  .card-head{display:flex;align-items:baseline;gap:12px;margin-bottom:10px}
  time{display:flex;align-items:baseline;gap:8px}
  .day{font-size:30px;font-weight:700;line-height:1;letter-spacing:.5px}
  .ym{font-size:15px;color:var(--ink-soft)}
  .chip{
    font-size:15px;color:#7a6a3a;background:rgba(201,162,39,.12);
    border-radius:999px;padding:3px 11px;
  }
  .chip.time{color:#2f7a4a;background:rgba(46,158,79,.12);font-variant-numeric:tabular-nums}
  .chip.tag{color:#8a6a12;background:rgba(201,162,39,.18);font-weight:700}
  .text{margin:0;font-size:17px;line-height:1.95;letter-spacing:.2px;white-space:pre-wrap}
  .meta{margin-top:12px;font-size:15px;color:#9d9287}
  .empty{
    background:#fff;border-radius:20px;padding:44px 24px;text-align:center;color:var(--ink-soft);
    box-shadow:0 10px 30px rgba(43,43,43,.06);font-size:15px;
  }
  footer{margin-top:36px;text-align:center;color:#b0a599;font-size:15px}
  @media (max-width:560px){
    body{padding:28px 14px 48px}
    h1{font-size:26px}
    .timeline{padding-left:18px}
    .card{padding:18px 18px 16px;border-radius:16px}
    .card::before{left:-19px;top:26px;width:9px;height:9px}
    .text{font-size:16px;line-height:1.85}
  }
  @media (prefers-color-scheme: dark){
    :root{--ink:#ece7e0;--ink-soft:#a79e94;--paper:#1b1917;--card:#242120}
    body{background:radial-gradient(1100px 460px at 50% -220px, rgba(46,158,79,.14), transparent 70%),linear-gradient(180deg,#1b1917,#14120f)}
    .card{border-color:rgba(255,255,255,.05);box-shadow:0 10px 30px rgba(0,0,0,.35)}
    .card::before{background:#1b1917}
    .empty{background:#242120}
    .chip{color:#d9c27a;background:rgba(201,162,39,.16)}
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1><span class="fish">🐟</span>大肥鱼的日记</h1>
      <div class="sub">${count ? `共 <b>${count}</b> 篇 · 最近一篇 ${latest}` : '还没有日记，等 Codex 关一次就有了'}</div>
    </header>
    ${count ? `<div class="timeline">${cards}</div>` : '<div class="empty">今天还没开始写呢～</div>'}
    <footer>由大肥鱼自动记录 · 只从 Codex 的提问里取材</footer>
  </div>
</body>
</html>`;

  fs.mkdirSync(diaryDir, { recursive: true });
  fs.writeFileSync(path.join(diaryDir, 'viewer.html'), html, 'utf8');
}

/** 一天的日记可能有多个时间点：`## 15:30 · 8 件事` */
const SECTION_RE = /^##\s+(\d{1,2}:\d{2})\s*(?:·\s*(\d+)\s*件事)?/;

/** 把某一天的文件读成 [{ time, text, count, tokens }]（按写入顺序）。 */
module.exports = { writeViewer, fontDataUrl, FONT_FAMILY };

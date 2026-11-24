// 金银监控站 Cloudflare Worker
//   GET /         服务端渲染：KV 历史 + 实时现货价，打开即最新
//   GET /data.json JSON 数据（调试用）
//   scheduled     定时抓价写入 KV（每天四次，北京时间）

const OZ_G = 31.1035; // 1 金衡盎司 = 31.1035 克

const SESSIONS = [
  { key: 'domestic_open', label: '中国开盘', time: '09:05', hour: 9 },
  { key: 'domestic_close', label: '中国收盘', time: '15:35', hour: 15 },
  { key: 'intl_open', label: '国际开盘', time: '21:35', hour: 21 },
  { key: 'intl_close', label: '国际收盘', time: '次日 02:35', hour: 2 },
];
const SESSION_KEYS = SESSIONS.map((s) => s.key);

// ---------- 每日壁纸 ----------
// 壁纸是 .webp 图片，GitHub 的 snapshot 推送只支持 UTF-8 文本，
// 所以仓库里存的是 base64 文本版（assets/wallpapers/<file>.b64），
// Worker 收到 /wallpapers/<file> 请求时，现从 GitHub raw 取回并解码成图片返回。
// 按北京时间一年中的第几天轮换，每天一张不重样。
// 新增壁纸：把 <file>.b64 放进仓库，并在 WALLPAPERS 里追加一条即可。
const WALLPAPER_BASE = 'https://raw.githubusercontent.com/sneoas/GAS/main/assets/wallpapers/';
const WALLPAPERS = [
  { file: 'wallpaper-01.webp', theme: '上海晨光 · 中国开盘' },
  { file: 'wallpaper-02.webp', theme: '伦敦黄昏 · 国际市场' },
  { file: 'wallpaper-03.webp', theme: '银月夜盘 · 国际收盘' },
  { file: 'wallpaper-04.webp', theme: '金银流光 · 抽象' },
  { file: 'wallpaper-05.webp', theme: '纽约晨光 · 华尔街' },
  { file: 'wallpaper-06.webp', theme: '故宫金瓦 · 日落' },
  { file: 'wallpaper-07.webp', theme: '雪山银白 · 黎明' },
  { file: 'wallpaper-08.webp', theme: '沙漠流金 · 黄昏' },
];
function wallpaperForBeijing(bj) {
  const start = Date.UTC(bj.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - start) / (24 * 3600 * 1000)) + 1;
  const idx = (dayOfYear - 1) % WALLPAPERS.length;
  const next = WALLPAPERS[(idx + 1) % WALLPAPERS.length];
  return { ...WALLPAPERS[idx], index: idx + 1, total: WALLPAPERS.length, nextTheme: next.theme };
}

// ---------- 时间（北京时间） ----------
function beijingNow(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000);
}
function fmtDate(bj) {
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function fmtTime(iso) {
  const bj = beijingNow(new Date(iso));
  return `${fmtDate(bj)} ${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
}
// 由北京时间推断本次 cron 属于哪个时段、归属哪个交易日（02:35 那笔归前一日）
function sessionForBeijing(bj) {
  const hour = bj.getUTCHours();
  const s = SESSIONS.find((x) => x.hour === hour);
  if (!s) return null;
  let tradeDate = fmtDate(bj);
  if (s.key === 'intl_close') {
    tradeDate = fmtDate(new Date(bj.getTime() - 24 * 3600 * 1000));
  }
  return { session: s.key, tradeDate };
}

// ---------- 行情抓取 ----------
async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchLive() {
  const out = {
    xau_usd: null,
    xag_usd: null,
    fx_rate: null,
    etf_price: null,
    etf_change_pct: null,
    as_of: new Date().toISOString(),
  };
  const [xau, xag, fx] = await Promise.allSettled([
    fetchJSON('https://api.gold-api.com/price/XAU'),
    fetchJSON('https://api.gold-api.com/price/XAG'),
    fetchJSON('https://open.er-api.com/v6/latest/USD'),
  ]);
  if (xau.status === 'fulfilled' && typeof xau.value.price === 'number') out.xau_usd = xau.value.price;
  if (xag.status === 'fulfilled' && typeof xag.value.price === 'number') out.xag_usd = xag.value.price;
  if (fx.status === 'fulfilled' && fx.value.rates && typeof fx.value.rates.CNY === 'number') out.fx_rate = fx.value.rates.CNY;
  // 中国黄金 ETF 518880：尽力而为，失败不影响主流程
  try {
    const q = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/518880.SS', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jin-yin-station/1.0)' },
    });
    const meta = q && q.chart && q.chart.result && q.chart.result[0] && q.chart.result[0].meta;
    if (meta && typeof meta.regularMarketPrice === 'number') {
      out.etf_price = meta.regularMarketPrice;
      if (typeof meta.chartPreviousClose === 'number' && meta.chartPreviousClose) {
        out.etf_change_pct = (meta.regularMarketPrice / meta.chartPreviousClose - 1) * 100;
      }
    }
  } catch (e) {
    console.log('ETF fetch failed (ignored):', e && e.message);
  }
  return out;
}

function cnyUnits(xau_usd, xag_usd, fx) {
  if (xau_usd == null || fx == null) return { xau_cny_g: null, xag_cny_kg: null };
  return {
    xau_cny_g: (xau_usd * fx) / OZ_G,
    xag_cny_kg: xag_usd == null ? null : ((xag_usd * fx) / OZ_G) * 1000,
  };
}

// ---------- KV ----------
async function kvGet(env, key) {
  try {
    return await env.STATION_KV.get(key, 'json');
  } catch (e) {
    console.log('KV get failed:', key, e && e.message);
    return null;
  }
}
async function kvPut(env, key, value) {
  await env.STATION_KV.put(key, JSON.stringify(value));
}

// ---------- 定时记录 ----------
async function handleScheduled(event, env) {
  const when = new Date((event && event.scheduledTime) || Date.now());
  const bj = beijingNow(when);
  const info = sessionForBeijing(bj);
  if (!info) {
    console.log('scheduled: no session for this hour (Beijing ' + bj.getUTCHours() + ':00), skip');
    return;
  }
  const { session, tradeDate } = info;
  // 周末 COMEX 休市，不记录
  const wd = new Date(tradeDate + 'T00:00:00Z').getUTCDay();
  if (wd === 0 || wd === 6) {
    console.log('scheduled: weekend trade_date, skip', tradeDate);
    return;
  }
  const dayKey = 'sessions:' + tradeDate;
  const day =
    (await kvGet(env, dayKey)) ||
    { trade_date: tradeDate, domestic_open: null, domestic_close: null, intl_open: null, intl_close: null };
  if (day[session]) {
    console.log('scheduled: already recorded', tradeDate, session);
    return;
  }
  const live = await fetchLive();
  if (live.xau_usd == null || live.xag_usd == null || live.fx_rate == null) {
    console.log('scheduled: live fetch failed, abort', JSON.stringify(live));
    return;
  }
  const cny = cnyUnits(live.xau_usd, live.xag_usd, live.fx_rate);
  const rec = {
    etf_change_pct: live.etf_change_pct,
    etf_price: live.etf_price,
    fx_rate: live.fx_rate,
    id: Number(tradeDate.replaceAll('-', '')) * 10 + SESSION_KEYS.indexOf(session),
    recorded_at: new Date().toISOString(),
    session,
    source_as_of: live.as_of,
    trade_date: tradeDate,
    xag_cny_kg: cny.xag_cny_kg,
    xag_usd: live.xag_usd,
    xau_cny_g: cny.xau_cny_g,
    xau_usd: live.xau_usd,
  };
  day[session] = rec;
  await kvPut(env, dayKey, day);
  // 更新 history：去重、按时间倒序、只保留近 30 天
  const history = (await kvGet(env, 'history')) || [];
  const seen = new Set(history.map((r) => r.trade_date + '|' + r.session));
  if (!seen.has(rec.trade_date + '|' + rec.session)) history.push(rec);
  history.sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? 1 : -1;
    return SESSION_KEYS.indexOf(b.session) - SESSION_KEYS.indexOf(a.session);
  });
  const cutoff = fmtDate(new Date(bj.getTime() - 30 * 24 * 3600 * 1000));
  const pruned = history.filter((r) => r.trade_date >= cutoff).slice(0, 200);
  await kvPut(env, 'history', pruned);
  console.log('scheduled: recorded', tradeDate, session, rec.xau_usd, rec.xag_usd);
}

// ---------- 渲染 ----------
function num(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '--';
  return Number(v).toFixed(digits);
}
function pctText(v) {
  if (v == null || Number.isNaN(v)) return '';
  return ` (${v >= 0 ? '+' : ''}${v.toFixed(2)}%)`;
}
function pctClass(v) {
  if (v == null || Number.isNaN(v)) return '';
  return v >= 0 ? 'up' : 'down';
}
// 上一交易日同时段的记录（用于涨跌对比）
function prevSameSession(history, session, tradeDate) {
  return history.find((r) => r.session === session && r.trade_date < tradeDate) || null;
}

function sessionCardHTML(day, history, metal, bjNow) {
  const today = day ? day.trade_date : '';
  return SESSIONS.map((s) => {
    const rec = day ? day[s.key] : null;
    let status, priceHTML, subHTML;
    if (rec) {
      const cur = metal === 'gold' ? rec.xau_cny_g : rec.xag_cny_kg;
      const usd = metal === 'gold' ? rec.xau_usd : rec.xag_usd;
      const prev = prevSameSession(history, s.key, today);
      let chg = null;
      if (prev) {
        const base = metal === 'gold' ? prev.xau_cny_g : prev.xag_cny_kg;
        if (base) chg = ((cur - base) / base) * 100;
      }
      status = '<span class="badge ok">已记录</span>';
      priceHTML = `<div class="price">¥${num(cur)}<span class="unit">${metal === 'gold' ? ' / 克' : ' / 千克'}</span></div>
        <div class="sub">$${num(usd)} / 盎司${chg == null ? '' : ` <span class="${pctClass(chg)}">${pctText(chg)}</span>`}</div>`;
      subHTML = `<div class="time">记录于 ${fmtTime(rec.recorded_at)}</div>`;
    } else {
      // 该时段是否已过（国际收盘按次日 02:35 算，未到次日都算待记录）
      const [hh, mm] = s.time === '次日 02:35' ? [26, 35] : s.time.split(':').map(Number);
      const nowMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
      const past = nowMin >= hh * 60 + mm;
      status = past ? '<span class="badge warn">未记录</span>' : '<span class="badge">待记录</span>';
      priceHTML = '<div class="price empty">--</div>';
      subHTML = `<div class="time">${s.time}${s.key === 'intl_close' ? '（归入前一日）' : ''}</div>`;
    }
    return `<div class="card">
      <div class="card-head"><span>${s.label}</span>${status}</div>
      <div class="card-time">${s.time}</div>
      ${priceHTML}${subHTML}
    </div>`;
  }).join('');
}

function historyTableHTML(history, metal) {
  // 按日期分组，最新在前；缺失的日期标休市
  const byDate = {};
  for (const r of history) {
    (byDate[r.trade_date] = byDate[r.trade_date] || {})[r.session] = r;
  }
  const dates = Object.keys(byDate).sort().reverse();
  if (dates.length === 0) return '<p class="empty-note">暂无历史记录（请先导入 seed.json）。</p>';
  const unit = metal === 'gold' ? '元/克' : '元/千克';
  const rows = [];
  let prev = dates[0];
  const dayMs = 24 * 3600 * 1000;
  for (const d of dates) {
    // 补上中间缺失的日期（周末休市）
    let cur = new Date(prev + 'T00:00:00Z').getTime();
    const target = new Date(d + 'T00:00:00Z').getTime();
    while (cur - target > dayMs) {
      cur -= dayMs;
      const wd = new Date(cur).getUTCDay();
      if (wd === 0 || wd === 6) {
        const ds = new Date(cur).toISOString().slice(0, 10);
        rows.push(`<tr class="closed"><td>${ds}</td><td colspan="4">休市</td></tr>`);
      }
    }
    prev = d;
    const cells = SESSIONS.map((s) => {
      const r = byDate[d][s.key];
      if (!r) return '<td>--</td>';
      const v = metal === 'gold' ? r.xau_cny_g : r.xag_cny_kg;
      return `<td>${num(v)}</td>`;
    }).join('');
    rows.push(`<tr><td>${d}</td>${cells}</tr>`);
    prev = d;
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>日期</th><th>中国开盘（${unit}）</th><th>中国收盘（${unit}）</th><th>国际开盘（${unit}）</th><th>国际收盘（${unit}）</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function finenessHTML(xauCnyG) {
  if (xauCnyG == null) return '';
  const rows = [
    ['足金 999', 0.999],
    ['足金 990', 0.99],
    ['足金 916', 0.916],
    ['18K 金 750', 0.75],
    ['14K 金 585', 0.585],
  ]
    .map(([name, k]) => `<tr><td>${name}</td><td>¥${num(xauCnyG * k)} / 克</td></tr>`)
    .join('');
  return `<section><h2>成品金成色折算</h2><p class="note">按最新黄金价 ¥${num(xauCnyG)} / 克折算，仅供参考。</p>
    <div class="table-wrap"><table><thead><tr><th>成色</th><th>折算价</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// 浏览器端脚本：金银切换 + 走势图（函数序列化进页面，避免模板嵌套转义问题）
function clientMain() {
  var DATA = window.__DATA__;
  var metal = 'gold';
  var SESSION_LABEL = { domestic_open: '中国开盘', domestic_close: '中国收盘', intl_open: '国际开盘', intl_close: '国际收盘' };
  var SESSION_ORDER = ['domestic_open', 'domestic_close', 'intl_open', 'intl_close'];

  function num(v, d) {
    if (v == null || isNaN(v)) return '--';
    return Number(v).toFixed(d == null ? 2 : d);
  }
  function metalValue(r) {
    return metal === 'gold' ? r.xau_cny_g : r.xag_cny_kg;
  }
  function metalUsd(r) {
    return metal === 'gold' ? r.xau_usd : r.xag_usd;
  }
  function renderBoard() {
    var day = DATA.sessions || {};
    var today = DATA.today;
    var html = '';
    SESSION_ORDER.forEach(function (key) {
      var rec = day[key];
      var label = SESSION_LABEL[key];
      var time = { domestic_open: '09:05', domestic_close: '15:35', intl_open: '21:35', intl_close: '次日 02:35' }[key];
      if (rec) {
        var cur = metalValue(rec);
        var prev = null;
        for (var i = 0; i < DATA.history.length; i++) {
          var r = DATA.history[i];
          if (r.session === key && r.trade_date < today) { prev = r; break; }
        }
        var chg = '';
        if (prev) {
          var base = metalValue(prev);
          if (base) {
            var p = ((cur - base) / base) * 100;
            chg = ' <span class="' + (p >= 0 ? 'up' : 'down') + '">(' + (p >= 0 ? '+' : '') + p.toFixed(2) + '%)</span>';
          }
        }
        html += '<div class="card"><div class="card-head"><span>' + label + '</span><span class="badge ok">已记录</span></div>'
          + '<div class="card-time">' + time + '</div>'
          + '<div class="price">¥' + num(cur) + '<span class="unit">' + (metal === 'gold' ? ' / 克' : ' / 千克') + '</span></div>'
          + '<div class="sub">$' + num(metalUsd(rec)) + ' / 盎司' + chg + '</div></div>';
      } else {
        html += '<div class="card"><div class="card-head"><span>' + label + '</span><span class="badge">待记录</span></div>'
          + '<div class="card-time">' + time + '</div><div class="price empty">--</div></div>';
      }
    });
    document.getElementById('board').innerHTML = html;
  }
  function renderTable() {
    var byDate = {};
    DATA.history.forEach(function (r) {
      (byDate[r.trade_date] = byDate[r.trade_date] || {})[r.session] = r;
    });
    var dates = Object.keys(byDate).sort().reverse();
    var unit = metal === 'gold' ? '元/克' : '元/千克';
    var html = '<div class="table-wrap"><table><thead><tr><th>日期</th><th>中国开盘（' + unit + '）</th><th>中国收盘（' + unit + '）</th><th>国际开盘（' + unit + '）</th><th>国际收盘（' + unit + '）</th></tr></thead><tbody>';
    dates.forEach(function (d) {
      html += '<tr><td>' + d + '</td>';
      SESSION_ORDER.forEach(function (key) {
        var r = byDate[d][key];
        html += '<td>' + (r ? num(metalValue(r)) : '--') + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    document.getElementById('history-table').innerHTML = html;
  }
  function drawChart() {
    var cv = document.getElementById('chart');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var pts = DATA.history.slice().sort(function (a, b) {
      if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
      return SESSION_ORDER.indexOf(a.session) - SESSION_ORDER.indexOf(b.session);
    });
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth;
    var h = 240;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (pts.length < 2) {
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.fillText('数据不足，无法绘图', 16, 30);
      return;
    }
    var vals = pts.map(metalValue).filter(function (v) { return v != null; });
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    var pad = (max - min) * 0.1 || 1;
    min -= pad;
    max += pad;
    var L = 64, R = 12, T = 14, B = 26;
    var X = function (i) { return L + (i * (w - L - R)) / (pts.length - 1); };
    var Y = function (v) { return T + (1 - (v - min) / (max - min)) * (h - T - B); };
    ctx.strokeStyle = '#e5e0d3';
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    for (var g = 0; g <= 4; g++) {
      var v = min + ((max - min) * g) / 4;
      var y = Y(v);
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(w - R, y);
      ctx.stroke();
      ctx.fillText(num(v, 0), 8, y + 4);
    }
    ctx.strokeStyle = '#b8860b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(function (r, i) {
      var v = metalValue(r);
      if (v == null) return;
      if (i === 0) ctx.moveTo(X(i), Y(v));
      else ctx.lineTo(X(i), Y(v));
    });
    ctx.stroke();
    ctx.fillStyle = '#b8860b';
    pts.forEach(function (r, i) {
      var v = metalValue(r);
      if (v == null) return;
      ctx.beginPath();
      ctx.arc(X(i), Y(v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    var step = Math.ceil(pts.length / 8);
    ctx.fillStyle = '#888';
    for (var j = 0; j < pts.length; j += step) {
      ctx.fillText(pts[j].trade_date.slice(5), X(j) - 10, h - 8);
    }
  }
  function renderAll() {
    renderBoard();
    renderTable();
    drawChart();
    var btns = document.querySelectorAll('.toggle button');
    btns.forEach(function (b) {
      b.classList.toggle('active', b.dataset.metal === metal);
    });
    document.getElementById('chart-title').textContent = metal === 'gold' ? '近 30 天走势 · 黄金（元/克）' : '近 30 天走势 · 白银（元/千克）';
    var liveGold = document.getElementById('live-gold');
    var liveSilver = document.getElementById('live-silver');
    if (liveGold && liveSilver) {
      liveGold.classList.toggle('active-metal', metal === 'gold');
      liveSilver.classList.toggle('active-metal', metal === 'silver');
    }
  }
  document.querySelectorAll('.toggle button').forEach(function (b) {
    b.addEventListener('click', function () {
      metal = b.dataset.metal;
      renderAll();
    });
  });
  window.addEventListener('resize', drawChart);
  renderAll();
}

function renderPage(data) {
  const { today, live, day, history, liveOk, bjNow, wallpaper } = data;
  const cny = cnyUnits(live.xau_usd, live.xag_usd, live.fx_rate);
  const xauCny = cny.xau_cny_g != null ? cny.xau_cny_g : live.xau_cny_g;
  const xagCny = cny.xag_cny_kg != null ? cny.xag_cny_kg : live.xag_cny_kg;
  const ratio = live.xau_usd && live.xag_usd ? live.xau_usd / live.xag_usd : null;
  const latestGold = xauCny != null ? xauCny : history.length ? history[0].xau_cny_g : null;

  const clientData = {
    today,
    live: { ...live, xau_cny_g: xauCny, xag_cny_kg: xagCny },
    sessions: day || { trade_date: today, domestic_open: null, domestic_close: null, intl_open: null, intl_close: null },
    history: [...history].sort((a, b) => {
      if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? 1 : -1;
      return SESSION_KEYS.indexOf(b.session) - SESSION_KEYS.indexOf(a.session);
    }),
  };
  const dataJson = JSON.stringify(clientData).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>金银监控站 · ${today}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f4ec; color: #26221a; }
  .bg { position: fixed; inset: 0; z-index: -1; background-size: cover; background-position: center; background-attachment: fixed; }
  .bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(247,244,236,0.72), rgba(247,244,236,0.88)); }
  .wrap { position: relative; z-index: 0; max-width: 960px; margin: 0 auto; padding: 16px; }
  header { padding: 8px 4px 4px; }
  h1 { margin: 0; font-size: 26px; }
  h1 span { color: #b8860b; }
  .sub { color: #777; margin: 6px 0 0; font-size: 14px; }
  h2 { font-size: 18px; margin: 26px 0 10px; }
  .live { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
  .live-box { background: rgba(255,255,255,0.93); border: 1px solid #e8e2d2; border-radius: 12px; padding: 16px; }
  .live-box.active-metal { border-color: #b8860b; box-shadow: 0 0 0 1px #b8860b inset; }
  .live-box .name { font-size: 15px; color: #666; }
  .live-box .big { font-size: 30px; font-weight: 700; margin: 6px 0 2px; }
  .live-box .big small { font-size: 14px; font-weight: 400; color: #666; }
  .live-box .row { font-size: 14px; color: #444; line-height: 1.7; }
  .meta { background: rgba(255,255,255,0.93); border: 1px solid #e8e2d2; border-radius: 12px; padding: 12px 16px; margin-top: 12px; font-size: 14px; line-height: 1.9; }
  .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .card { background: rgba(255,255,255,0.93); border: 1px solid #e8e2d2; border-radius: 12px; padding: 14px; }
  .card-head { display: flex; justify-content: space-between; align-items: center; font-size: 15px; font-weight: 600; }
  .card-time { color: #999; font-size: 13px; margin-top: 2px; }
  .price { font-size: 22px; font-weight: 700; margin-top: 10px; }
  .price .unit { font-size: 13px; font-weight: 400; color: #666; }
  .price.empty { color: #bbb; }
  .sub { font-size: 13px; color: #666; margin-top: 4px; }
  .time { font-size: 12px; color: #999; margin-top: 6px; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 20px; background: #eee; color: #666; }
  .badge.ok { background: #e4f2e7; color: #1e8449; }
  .badge.warn { background: #fdebd0; color: #b9770e; }
  .up { color: #c0392b; }
  .down { color: #1e8449; }
  .toggle { display: inline-flex; border: 1px solid #ddd; border-radius: 20px; overflow: hidden; margin-left: 8px; vertical-align: middle; }
  .toggle button { border: 0; background: #fff; padding: 5px 14px; font-size: 13px; cursor: pointer; }
  .toggle button.active { background: #b8860b; color: #fff; }
  canvas { width: 100%; background: rgba(255,255,255,0.93); border: 1px solid #e8e2d2; border-radius: 12px; }
  .table-wrap { overflow-x: auto; background: rgba(255,255,255,0.93); border: 1px solid #e8e2d2; border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 9px 10px; text-align: right; border-bottom: 1px solid #f0ead9; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  thead th { background: #faf7ef; position: sticky; top: 0; }
  tr.closed td { color: #aaa; text-align: center; }
  .note { font-size: 13px; color: #888; line-height: 1.8; }
  .empty-note { color: #888; }
  footer { margin: 28px 0 10px; font-size: 12px; color: #999; line-height: 1.9; border-top: 1px solid #e8e2d2; padding-top: 12px; }
  @media (max-width: 640px) {
    .board { grid-template-columns: 1fr 1fr; }
    .live { grid-template-columns: 1fr; }
    .live-box .big { font-size: 26px; }
  }
</style>
</head>
<body>
<div class="bg" style="background-image:url('/wallpapers/${wallpaper.file}')"></div>
<div class="wrap">
  <header>
    <h1>金银<span>监控站</span></h1>
    <p class="sub">黄金 · 白银 中国 / 国际开收盘记录 · 每天四次自动记录（北京时间）· 打开即最新</p>
  </header>

  <section class="live">
    <div class="live-box ${'active-metal'}" id="live-gold">
      <div class="name">黄金现货</div>
      <div class="big">$${num(live.xau_usd)} <small>/ 盎司</small></div>
      <div class="row">¥${num(xauCny)} / 克</div>
      <div class="row">中国黄金 ETF 518880：${live.etf_price != null ? '¥' + num(live.etf_price) + pctText(live.etf_change_pct) : '暂无'}</div>
    </div>
    <div class="live-box" id="live-silver">
      <div class="name">白银现货</div>
      <div class="big">$${num(live.xag_usd)} <small>/ 盎司</small></div>
      <div class="row">¥${num(xagCny)} / 千克</div>
      <div class="row">金银比：${ratio != null ? num(ratio, 1) : '--'}</div>
    </div>
  </section>
  <div class="meta">
    美元 / 人民币：${live.fx_rate != null ? num(live.fx_rate, 4) : '--'}　·　实时价更新于 ${fmtTime(live.as_of)}
    ${liveOk ? '' : '<br>实时价获取失败，显示最近一次记录的价格。'}
  </div>

  <section>
    <h2>今日四时段 · ${today}</h2>
    <div class="board" id="board">${sessionCardHTML(day, history, 'gold', bjNow)}</div>
  </section>

  <section>
    <h2><span id="chart-title">近 30 天走势 · 黄金（元/克）</span>
      <span class="toggle"><button data-metal="gold" class="active">黄金</button><button data-metal="silver">白银</button></span>
    </h2>
    <canvas id="chart"></canvas>
  </section>

  <section>
    <h2>历史记录</h2>
    <div id="history-table">${historyTableHTML(history, 'gold')}</div>
  </section>

  ${finenessHTML(latestGold)}

  <footer>
    今日壁纸：${wallpaper.theme}（${wallpaper.index} / ${wallpaper.total}）· 每天更换，明天是「${wallpaper.nextTheme}」。<br>
    人民币价为国际现货按实时汇率折算，非上金所成交价。<br>
    周末 COMEX 休市，无开收盘记录；法定节假日同理。<br>
    实时价来源 gold-api.com；汇率来源 open.er-api.com；ETF 518880 行情来源 Yahoo Finance。<br>
    数据更新于 ${fmtTime(new Date().toISOString())}（北京时间）。
  </footer>
</div>
<script>
window.__DATA__ = ${dataJson};
(${clientMain.toString()})();
</script>
</body>
</html>`;
}

// ---------- 入口 ----------
async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
  // 壁纸等静态资源：从 GitHub raw 取 base64 文本，解码成图片返回
  if (url.pathname.startsWith('/wallpapers/')) {
    const file = url.pathname.slice('/wallpapers/'.length);
    if (!/^wallpaper-\d+\.webp$/.test(file)) return new Response('Not Found', { status: 404 });
    try {
      const r = await fetch(WALLPAPER_BASE + file + '.b64');
      if (!r.ok) return new Response('Not Found', { status: 404 });
      const b64 = (await r.text()).replace(/\s/g, '');
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400' },
      });
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  }
  const bj = beijingNow();
  const todayStr = fmtDate(bj);
  const wallpaper = wallpaperForBeijing(bj);
  const history = (await kvGet(env, 'history')) || [];
  const day = (await kvGet(env, 'sessions:' + todayStr)) || null;

  if (url.pathname === '/data.json') {
    const live = await fetchLive();
    const cny = cnyUnits(live.xau_usd, live.xag_usd, live.fx_rate);
    return new Response(
      JSON.stringify({ today: todayStr, live: { ...live, ...cny }, sessions: day, history }),
      { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
  if (url.pathname !== '/') return new Response('Not Found', { status: 404 });

  const live = await fetchLive();
  let liveOk = live.xau_usd != null && live.xag_usd != null && live.fx_rate != null;
  if (!liveOk) {
    // 实时价失败：用最近一条记录兜底
    const last = history[0];
    if (last) {
      live.xau_usd = last.xau_usd;
      live.xag_usd = last.xag_usd;
      live.fx_rate = last.fx_rate;
      live.xau_cny_g = last.xau_cny_g;
      live.xag_cny_kg = last.xag_cny_kg;
      if (live.etf_price == null) {
        live.etf_price = last.etf_price;
        live.etf_change_pct = last.etf_change_pct;
      }
    }
  }
  const html = renderPage({ today: todayStr, live, day, history, liveOk, bjNow: bj, wallpaper });
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
};

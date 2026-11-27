# 金银监控站 · Cloudflare Worker 版

每天四次自动记录黄金、白银开收盘价（北京时间），公开链接打开即最新数据，
不用重新部署、不用重新分享。

## 它是怎么工作的

- **页面**：Worker 每次收到请求时，现从 KV 读历史记录，再实时从
  gold-api.com 抓黄金/白银现货价，服务端渲染成 HTML 返回。
  打开多少次都是最新数据。
- **记录**：Worker 的定时触发器（cron）在北京时间每天
  09:05 中国开盘、15:35 中国收盘、21:35 国际开盘、次日 02:35 国际收盘
  各抓一次现货价，写入 KV。02:35 那笔归入前一日。
- **数据**：存在 KV 里，两个键：
  - `history`：近 30 天的时段记录数组（最新在前）
  - `sessions:YYYY-MM-DD`：某一个交易日的四个时段对象
- **命名**：一律用中国 / 国际区分，不用国内 / 国外。

## 部署步骤

### 1. 推到 GitHub

用户已建好空仓库 `sneoas/GAS`，把本目录内容推上去：

```bash
git init
git add .
git commit -m "金银监控站 Worker 版"
git branch -M main
git remote add origin https://github.com/sneoas/GAS.git
git push -u origin main
```

### 2. 创建 KV namespace

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create STATION_KV
```

把返回的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]` 里。

> 注意：Worker 的定时触发（cron）需要 **Workers Paid 计划**（约 $5/月）。
> 免费版可以部署、可以打开页面，但定时任务不会跑。
> 如果暂时不想付费，可以先部署页面，记录先靠手动跑
> `wrangler dev --test-scheduled` 或以后再开付费。

### 3. 导入种子数据

`seed.json` 是从主站导出的 30 天历史（2026-10-26 至 2026-11-23，
共 81 条真实记录）加今天已有的 15:35 中国收盘真价
（黄金 $3633.05 / 780.41 元/克，白银 $42.533 / 9136 元/千克）。
部署后执行一次：

```bash
bash scripts/seed.sh
```

它会把 `history` 和 21 个 `sessions:YYYY-MM-DD` 键写入 KV。
也可以手动单条导入，例如：

```bash
wrangler kv key put history --binding STATION_KV --path seed-history.json
```

### 4. 部署

```bash
wrangler deploy
```

成功后会给一个地址，形如：

```
https://jin-yin-jian-kong-zhan.<你的子域名>.workers.dev
```

这就是公开链接，任何人打开都是最新数据，不用重新部署。

### 5. 检查定时任务

部署后在 Cloudflare Dashboard → Workers → jin-yin-jian-kong-zhan →
Triggers 里确认 4 条 cron 都在。
也可以手动触发一次测试：

```bash
wrangler dev --test-scheduled
```

## 每日壁纸

页面背景每天换一张，不重样，按北京时间一年中的第几天轮换：

- 01 上海晨光 · 中国开盘、02 伦敦黄昏 · 国际市场、03 银月夜盘 · 国际收盘、04 金银流光 · 抽象、05 纽约晨光 · 华尔街、06 故宫金瓦 · 日落、07 雪山银白 · 黎明、08 沙漠流金 · 黄昏、09 迪拜金市 · 午后、10 金阁晨光 · 京都、11 威尼斯金色黄昏 · 运河（共 11 张，11 天一轮）
- 壁纸是 AI 生成的 2048×1152 图片，页面上加了一层浅色渐变遮罩，卡片是半透明白底，文字可读性不受影响
- 仓库里存的是 base64 文本版（`assets/wallpapers/wallpaper-*.webp.b64`，GitHub 快照推送只支持 UTF-8 文本），Worker 收到 `/wallpapers/<file>` 时现从 GitHub raw 取回解码成图片返回
- 新增壁纸：生成新图 → 转 base64 存进仓库 → 在 `src/index.js` 的 `WALLPAPERS` 里追加一条，下次请求即生效，不用改页面结构

## 本地开发

```bash
wrangler dev
```

本地开发时 KV 默认用远端绑定（需要已登录）；加 `--local` 可用本地模拟 KV。

## 数据口径

- 人民币价 = 国际现货（美元/盎司）× 美元/人民币汇率 ÷ 31.1035；
  黄金是元/克，白银是元/千克。**不是上金所成交价**，页面上有说明。
- 汇率来源：open.er-api.com；实时金银价来源：gold-api.com；
  中国黄金 ETF 518880 行情来源：Yahoo Finance（拿不到就记 null，不影响记录）。
- 周末 COMEX 休市，不记录；02:35 的国际收盘归入前一日。
- 历史只保留近 30 天，旧记录由定时任务自动裁剪。

## 深圳水贝

- 来源：金价查询网数据文件 `https://res.huangjinjiage.com.cn/shuibei.js`
  （`const shuipei = {...}`，约 1–2 分钟一更）。必须带 `?t=<毫秒时间戳>`，
  否则会拿到 12 小时缓存的旧数据。
- 每天抓两次：09:05（早盘）和 15:35（午后收盘），只在当日时段价记好之后抓，
  抓不到就跳过，绝不影响四个时段记价。周末水贝照常营业，照抓。
- 页面显示 8 项（元/克）：首饰金、会员金条、非会员投资金、黄金 9999、
  白银挂牌、铂金、钯金、回收参考；KV 里存全量字段（另有吉盟投资金、
  黄金 9999 回收、白银/铂金/钯金回收价）。
- KV：`shuibei:YYYY-MM-DD`（`{ trade_date, open, close }`）、
  `shuibei_history`（近 30 天）。`/data.json` 里也有 `shuibei` 字段。
- 水贝无统一官方价，这是商户参考价，各店略有浮动，页面上写明
  “各店价格不同，仅供参考”，并标来源和抓取时间。
- 不要用固定页 `golden/121169.html`、`quote/114636.html` 的静态数字，
  它们是数小时前的旧快照。

## 补录 / 重新同步

如果历史丢了或想重置：重新从主站导出最新数据，替换 `seed.json`，
再跑一次 `bash scripts/seed.sh`（同名键会被覆盖，不会重复）。

## 文件一览

| 文件 | 说明 |
| --- | --- |
| `wrangler.toml` | Worker 配置：KV 绑定、cron 触发器 |
| `src/index.js` | Worker 脚本：页面渲染 + 定时记录 |
| `seed.json` | 种子数据：30 天历史 + 今天的记录 |
| `scripts/seed.sh` | 把 seed.json 导入 KV |
| `README.md` | 本文件 |

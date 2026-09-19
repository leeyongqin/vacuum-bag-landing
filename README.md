# 集尘袋留评落地页 — 部署指南

域名：amazon-feedback.aromelivii.com
平台：Cloudflare Workers + Static Assets + KV

> ⚠️ 2026 年起 Cloudflare 已停止对 Pages 的新功能投入，统一迁移到「Workers + Static
> Assets」模型。本项目已从旧的 Pages Functions（`functions/` 目录 + `_redirects`）
> 迁移为标准 Worker（`src/worker.js` + `wrangler.jsonc`），这样才能在 Dashboard /
> 配置文件里正常绑定环境变量和 KV —— 纯静态资产（没有 `main` 入口脚本）的 Worker
> 无法添加变量或 KV 绑定，这正是旧部署方式踩到的坑。

---

## 文件结构

```
/
├── public/              ← 静态资源目录（对应 wrangler.jsonc 里的 assets.directory）
│   ├── index.html       ← 主落地页（5语言自动检测）
│   └── dashboard.html   ← 数据统计面板
├── src/
│   └── worker.js        ← Worker 入口：路由 /api/* + 静态资源回退 + /dashboard 重写
└── wrangler.jsonc        ← Worker 配置（assets / KV 绑定都在这里声明）
```

`/api/track`、`/api/submit`、`/api/stats`、`/dashboard` 的重写规则全部在
`src/worker.js` 里实现，不再依赖 `_redirects` 或 Pages Functions 的文件路由约定。

---

## 部署步骤

### 0. 安装依赖

```bash
npm install -g wrangler   # 或用 npx wrangler 代替下面所有 wrangler 命令
wrangler login
```

### 1. 创建 KV 命名空间

```bash
wrangler kv namespace create ANALYTICS_KV
```

把返回的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

### 2. 设置密钥（保护统计面板）

```bash
wrangler secret put STATS_SECRET
```

按提示输入你要设置的密码（不会写入代码仓库，安全存储在 Cloudflare）。

### 3. 确认 Worker 名称

**如果你在 Dashboard 里已经有一个部署好的 Worker**，打开
`wrangler.jsonc`，把 `"name"` 改成和现有 Worker **完全一致**的名字，这样
`wrangler deploy` 会更新原有 Worker，而不是新建一个（新建的话自定义域名需要
重新绑定）。

### 4. 部署

```bash
wrangler deploy
```

### 5. 绑定自定义域名

Cloudflare Dashboard → Workers & Pages → 选中该 Worker → Settings →
Domains & Routes → Add Custom Domain：

```
amazon-feedback.aromelivii.com
```

### 6. 之后如需修改变量 / KV 绑定

优先直接改 `wrangler.jsonc` 后重新 `wrangler deploy`（推荐，改动可追溯到
Git 历史）。也可以在 Dashboard → 该 Worker → Settings → Variables and
Secrets / Bindings 里改——因为现在 Worker 已经有 `main` 入口脚本，这两个
入口在 Dashboard 上应该会正常显示了。

---

## 访问统计面板

部署完成后，浏览器打开：

```
https://amazon-feedback.aromelivii.com/dashboard
```

输入你设置的 `STATS_SECRET` 即可查看：
- 每日浏览量 / 提交数 / 转化率
- 各语言访问分布（德/法/意/西/英）
- 14天每日明细

---

## API 接口说明

| 接口 | 方法 | 说明 |
|------|------|------|
| /api/track | POST | 记录浏览事件 |
| /api/submit | POST | 保存表单提交 |
| /api/stats?secret=xxx&days=7 | GET | 读取统计数据 |

---

## 获取提交的邮件列表

使用 Cloudflare KV API 或在 Dashboard 里直接查看 KV 存储：

- Key 格式 `leads:YYYY-MM-DD` → 当日所有提交的 JSON 数组
- Key 格式 `lead:YYYY-MM-DD:email` → 单条记录（含状态）

可将 status 字段改为 `sent` 来标记已发放礼品卡：
```json
{ "email": "xx@xx.de", "order_suffix": "5678", "lang": "de", "ts": "...", "status": "sent" }
```

---

## 注意事项

- KV 免费套餐：每天 10 万次读/写，足够日均数千访问
- 数据保留：pageview 统计 90 天，leads 记录 180 天
- 倒计时为前端装饰性计时（每次刷新重置），不影响实际有效期
- GDPR 声明已内置各语言版本，符合欧盟合规要求
- `wrangler.jsonc` 已提交到仓库，但 **不含任何密钥**（`STATS_SECRET` 通过
  `wrangler secret put` 单独存储，不会出现在代码或 Git 历史里）

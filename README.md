# 集尘袋留评落地页 — 部署指南

域名：amazon-feedback.aromelivii.com  
平台：Cloudflare Pages + Functions + KV

---

## 文件结构

```
/
├── index.html          ← 主落地页（5语言自动检测）
├── dashboard.html      ← 数据统计面板
├── _redirects          ← Cloudflare 路由配置
└── functions/
    └── api/
        ├── track.js    ← 浏览统计接口 POST /api/track
        ├── submit.js   ← 表单提交接口 POST /api/submit
        └── stats.js    ← 数据读取接口 GET /api/stats
```

---

## 部署步骤

### 1. 上传到 GitHub

```bash
git init
git add .
git commit -m "init landing page"
git remote add origin https://github.com/你的账号/vacuum-bag-landing.git
git push -u origin main
```

### 2. Cloudflare Pages 连接仓库

1. 登录 Cloudflare Dashboard → Pages → Create a project
2. Connect to Git → 选择刚创建的仓库
3. Build settings 全部留空（纯静态 + Functions，不需要构建命令）
4. 点击 Save and Deploy

### 3. 绑定自定义域名

Pages 部署成功后：
- Settings → Custom domains → Add domain
- 输入：`amazon-feedback.aromelivii.com`
- 按提示在 Cloudflare DNS 添加 CNAME 记录（域名已在 CF 管理则自动完成）

### 4. 创建 KV 命名空间

Cloudflare Dashboard → Workers & Pages → KV：

```
新建命名空间，名称：ANALYTICS_KV
```

然后在 Pages 项目 → Settings → Functions → KV namespace bindings：

| Variable name  | KV namespace  |
|----------------|---------------|
| ANALYTICS_KV   | ANALYTICS_KV  |

### 5. 设置环境变量

Pages → Settings → Environment variables → Production：

| 变量名        | 值（自定义）         | 说明                |
|--------------|---------------------|---------------------|
| STATS_SECRET | 你设置的任意密码     | 保护统计面板的密钥   |

---

## 访问统计面板

部署完成后，浏览器打开：

```
https://amazon-feedback.aromelivii.com/dashboard
```

输入你设置的 STATS_SECRET 即可查看：
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

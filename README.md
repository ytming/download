# 软件下载中心（EdgeOne Pages 版）

一个「软件 → 版本 → 下载链接」展示页，带管理后台，可随时改标题、增删软件、版本与自定义命名的下载链接。
已改造为 **腾讯云 EdgeOne Pages** 的原生结构：静态页面 + Pages Functions + EdgeOne Blob，
不再依赖 Cloudflare Workers / D1，可直接把仓库推到 GitHub 后在 EdgeOne 控制台导入部署。

> 存储用 **EdgeOne Blob（`@edgeone/pages-blob` SDK）**：代码里 `getStore({ name, consistency: 'strong' })`
> 首次调用会**自动创建命名空间**，不需要在控制台手动创建/绑定任何 KV 或 Blob，部署完即可写数据。

## 目录结构

```
.
├── index.html                     # 静态首页（下载页 + 管理后台，全部内联，无构建步骤）
├── functions/
│   └── api/
│       └── [[default]].js         # Pages Function：/api/** 全部接口（读写 Blob）
├── scripts/
│   └── dev-server.mjs             # 本地预览服务器（模拟 EO 运行时，零依赖）
├── package.json                   # 依赖 @edgeone/pages-blob；提供 npm run dev
├── .gitignore
└── README.md
```

路由映射由 EdgeOne 按文件名生成，不需要额外配置：

| 请求 | 命中的函数文件 |
| --- | --- |
| `GET /` | 静态 `index.html` |
| `GET /api/data` | `functions/api/[[default]].js` |
| `POST /api/login` | 同上 |
| `PUT /api/data` | 同上 |
| `PUT /api/password` | 同上 |
| `GET /api/health` | 同上（返回 `storage: "blob"` 表示存储就绪） |

## 本地预览

需要 Node.js 18+：

```bash
npm install     # 只为拿到 @edgeone/pages-blob（本地已内置 shim，可跳过）
npm run dev
# 或
node scripts/dev-server.mjs
```

打开 <http://127.0.0.1:3000> 即可看到页面；右上角「管理后台」（或 `Ctrl/⌘ + Shift + A`）进入后台，
默认密码 `admin`。

本地服务器会模拟 EdgeOne 的运行时：

- `functions/` 目录按文件名路由，支持 `[id]`、`[[default]]` 通配；
- 注入 `context.request / context.env / context.params`；
- `@edgeone/pages-blob` 走 `node_modules` 里的本地 shim，数据落在 `.dev/blob.json`（重启不丢，已被 git 忽略）。

想换端口：`PORT=8080 npm run dev`；想改本地密码：在项目根目录建 `.env` 写 `ADMIN_PASSWORD=你的密码`。

## 部署到 EdgeOne Pages

1. **推送到 GitHub**：把这个目录作为仓库根目录提交并推送。
2. **导入项目**：EdgeOne 控制台 → Pages/Makers → 创建项目 → 导入 Git 仓库 → 选择该仓库。
3. **构建设置**（本项目无需构建）：
   - 框架预设：`无` / `Other`
   - 构建命令：**留空**
   - 输出目录：`/`（仓库根目录，默认值）
   - 安装命令：`npm install`（会安装 `@edgeone/pages-blob`，**必须保留**）
4. **无需绑定任何存储**：代码里 `getStore({ name: 'software-download', consistency: 'strong' })`
   会在首次调用时自动创建 Blob 命名空间，控制台不用手动建容器、不用填变量名。
5. **设置管理密码（建议）**：项目设置 → 环境变量 → 添加 `ADMIN_PASSWORD=你的强密码`，然后重新部署。
6. 访问平台分配的 `*.edgeone.app` 域名，或绑定自己的域名 / CNAME。

> 部署后先访问 `/api/health`：返回 `{"ok":true,"storage":"blob"}` 说明 Blob 已就绪、可以保存数据。

## 接口说明

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/data` | 读取站点数据，返回 `{ ok, storage, data }`；`storage` 为 `blob` |
| `PUT` | `/api/data` | 整份保存，需请求头 `x-admin-password` |
| `POST` | `/api/login` | 校验密码，body `{ password }` |
| `PUT` | `/api/password` | 修改密码，header 带当前密码，body `{ newPassword }` |
| `GET` | `/api/health` | 健康检查，返回 `{ ok, storage }` |

数据存在 Blob 的 `software-download` 命名空间下，键为 `site-data.json`，形如：

```json
{
  "title": "📦 软件下载中心",
  "subtitle": "选择软件与版本，复制链接或直接下载",
  "softwares": [
    {
      "name": "微信 PC 版",
      "note": "1. 安装前请先退出旧版微信；\n2. 下载后请核对数字签名。",
      "versions": [
        {
          "version": "3.9.12",
          "links": [
            { "name": "官方直链", "url": "https://…" },
            { "name": "备用地址", "url": "https://…" }
          ]
        }
      ]
    }
  ],
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

> 三层结构：**软件 → 版本 → 链接**。每个版本可以挂多条自定义命名的链接，后台每条链接只需填「名称 + 一个直链」，备用地址当作第二条链接加即可。
> `note` 是**软件级**的「注意事项」，显示在主页面下载链接下方的大框里，切换版本不会变化，只随软件切换。
> `backupUrl` 字段仍被兼容（旧数据不会丢），但后台已不再单独编辑它。
> 旧数据会被自动迁移：`软件 → 版本{url}` 会转成该版本下一条名为「直链下载」的链接；
> `软件 → links[]` 会整包归入一个名为「最新版本」的版本。

## 与 Cloudflare 版本的差异

| 项目 | 改造前（Cloudflare） | 改造后（EdgeOne） |
| --- | --- | --- |
| 入口 | `export default { fetch }`（Workers） | `export function onRequest(context)`（Pages Functions） |
| 路由 | 代码内判断 | `functions/api/[[default]].js` 文件即路由 |
| 存储 | D1（`env.DB.batch` / SQL） | Blob（`@edgeone/pages-blob`，`store.get` / `store.set`） |
| 建表 / 绑定 | `CREATE TABLE` + 迁移 | 全自动：`getStore` 首次调用即创建命名空间 |
| 页面 | `page.js` 字符串模块 | 独立 `index.html`，走静态托管 |
| 密码 | `env.ADMIN_PASSWORD`，页面改不了 | 同上为初始值，页面内可改（存 Blob） |
| 本地开发 | `wrangler dev` | `npm run dev`（自带模拟器 + Blob shim） |

## 常见问题

- **后台提示只读 / 保存报错**：先访问 `/api/health`，看 `storage` 是否为 `blob`。
  如果不是，通常是构建时没执行 `npm install`（`@edgeone/pages-blob` 未安装）。
- **改了数据多久生效**：Blob 走强一致（`consistency: 'strong'`），保存后立即读到的就是新值。
- **忘记管理密码**：到 Blob 命名空间 `software-download` 下删掉 `admin-password` 键（回退到环境变量
  `ADMIN_PASSWORD`），或直接改环境变量后重新部署。
- **页面 404**：检查输出目录是否为 `/`，以及 `index.html` 是否在仓库根目录。
- **数据太大**：单个值超过约 900KB 会被拒绝，精简软件/版本数量即可。

## 安全提示

- 部署时务必设置 `ADMIN_PASSWORD`，不要用默认的 `admin`。
- 管理密码通过 `x-admin-password` 请求头校验，全站建议启用 HTTPS（EdgeOne 默认提供）。
- 下载直链会拦截 `javascript:` `data:` 等危险协议，但外链安全性仍取决于你填写的地址。

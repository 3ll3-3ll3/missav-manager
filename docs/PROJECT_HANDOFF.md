# TG 内容工具箱 v0.5 交接说明

更新时间：2026-07-26
主线分支：`codex/v0.5-redesign`
项目根目录：`E:\Desktop\codex项目\missav-manager`

## 当前正式结构

新应用全部位于 `apps/desktop-v05`：

```text
apps/desktop-v05/
├─ src/                         Vue 工具页面
│  ├─ components/               首页、五工具、Raindrop、来源、数据中心等
│  ├─ processing.ts             输入文件和五类工具的规则编排
│  └─ generated/legacyBundle.js 已测试 v0.4.5 规则的浏览器包
├─ src-tauri/src/
│  ├─ workspace.rs              正式 SQLite、CRUD、备份、迁移、日志
│  ├─ network.rs                受限 HTTPS 请求、站点与 Raindrop 网关
│  ├─ telegram_user.rs          Telegram 个人 API、DPAPI 凭据、群/频道增量
│  ├─ chrome_bridge.rs          Chrome 扩展本机串行收藏桥
│  └─ lib.rs                    Tauri 命令边界和启动迁移
└─ scripts/build-legacy.mjs     将根目录已测试规则预构建为 ESM
```

根目录 Electron v0.4.5 仅作旧版本与规则来源保留。不要在 v0.5 工作中修改其正式数据库；v0.5 只通过“v0.4.5 数据迁移”页面只读导入。

## 数据位置与迁移

v0.5 默认数据库为 `tg-content-toolbox-v05.sqlite`。启动时优先使用用户选择的位置；否则使用 v0.5 应用数据目录。早期 `prototype-v05.sqlite` 与早期 `.next` 应用目录会被安全迁移到正式文件名，不会触碰 `com.wjl.missav-manager` 的 v0.4.5 数据。

`workspace.rs` 是唯一的业务表写入口。写入前必须维持：父记录校验、唯一键校验、JSON/数值校验、自动备份、事务与日志脱敏。任何测试应设置 `TG_TOOLBOX_V05_DATA_DIR` 到临时目录。

## Telegram 安全与网络

个人 API 由 Rust `grammers` 驱动；API 凭据用 Windows DPAPI 加密，Telegram 会话独立存放在 v0.5 数据目录。日志不得写 API hash、手机号、验证码、密码、二维码 URL、Bot Token 或 Raindrop Token。

个人 API 使用 SOCKS5。设置页的 Clash `http://127.0.0.1:7890`/Mixed Port 会自动转换为 `socks5://127.0.0.1:7890`。群组/超级群/频道通过 API 真实枚举；每个来源用消息 ID 检查点增量读取。Bot 仅用于 Bot API 更新，不得假装能读取完整历史。

## 123AV 约束

同一个 123AV 账号操作永远只有一路。Chrome 扩展由 `chrome_bridge.rs` 提供随机本机配对码，扩展仅允许访问 `127.0.0.1` 并 Bearer 鉴权。不得新增读取 Cookie、密码、Local Storage、Session Storage 或完整页面 HTML 的逻辑。

APP 内窗口仅为人工串行助手；自动收藏交给 Chrome 扩展。所有不确定、网络或验证状态应持久化为待核验/网络错误，不能默认成功或无条件重试。

## Raindrop 约束

同步前必须预览。Collection 由用户多选，Pull/Push/双向均以规范化番号和可信 MissAV 链接为身份。全账号已经同时存在的番号一律不写入，忽略 Collection 位置；Pull 必须保留远端全部 Tags。令牌仅当前会话使用。

## 验收命令

```powershell
cd E:\Desktop\codex项目\missav-manager\apps\desktop-v05
npm run check
npm run test:rust
npm run build:web
npm run tauri -- build

cd E:\Desktop\codex项目\missav-manager
npm test
```

当前验收基线：根目录规则回归 139 项；v0.5 Rust 单测 9 项；`npm run check` 与 `npm run build:web` 均通过。最终文件为 `apps/desktop-v05/src-tauri/target/release/tg-content-toolbox-v05.exe`，大小 `19,280,384` 字节，SHA-256 为 `2CE74E6D77315C811D0789F886A2EE6C03D5F18D3BF22FAE90C8582181E259B2`。

本开发机的隔离窗口启动会在 Tauri 创建 Windows WebView 窗口前受到系统策略的“拒绝访问”阻拦，无法作为用户机 GUI 冒烟验证。该限制与业务数据库无关；构建、类型检查和所有自动测试已通过。Chrome 扩展桥已经降级为可选功能：若本机禁止监听本地端口，APP 仍可启动，其余模式照常可用。

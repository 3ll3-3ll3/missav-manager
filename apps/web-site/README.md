# MissAV Manager Private Web

这是 `missav-manager` v0.5.13 Windows 工具的 B 账号私人网站版本。网站复刻业务规则与数据工作流，不直接转换 EXE，也不复制 Tauri/Rust 桌面外壳。

## 稳定参考

- 分支：`codex/v0.5.13-desktop-stable`
- 标签：`v0.5.13-desktop-baseline`
- 提交：`4e2aad0`

稳定分支、固定标签和现有 Windows Release 是独立回退版本，本项目不修改它们。

## 网站能力

- 推特博主、Bad.news、海角链接与 MissAV 番号的 v0.5.13 兼容过滤规则。
- 多文件导入、粘贴文本、Telegram HTML/JSON 时间筛选、预览、复制与 TXT/CSV/JSON 导出。
- 永久历史、参考女优 Tag 库、参考库黑名单和 Raindrop 导出黑名单。
- 具备服务端搜索、排序、筛选、分页、跨页全选、Ctrl/Shift 多选、单元格编辑、批量修改、删除、复制和导出的数据中心。
- D1 持久化与服务端分页；浏览器不会一次加载全部正式记录，也不使用 Local Storage 保存正式数据。
- Raindrop CSV 与 Netscape 书签 HTML 生成；第二层黑名单会从 Raindrop 文件中排除匹配记录。
- 脱敏 JSON/CSV 的预览、计数、SHA-256 核对、分批写入和批次回滚。
- Telegram Bot API 增量、官方 JSON 导入、来源多对多绑定和工具独立队列。

## Telegram 个人账号 API 状态

网站必须实现个人账号 MTProto，并尽可能复刻 Windows v0.5.13 的二维码/手机号登录、验证码、两步验证、Session、来源发现、历史、连续增量和三种已读策略。Windows 端同时保留，二者 Session、来源和检查点彼此独立。

当前提交只完成 Bot、官方 JSON、绑定和工具队列；个人账号 MTProto 尚未完成真实登录与远端验收，因此 Telegram 整体状态是“未完成”。不得把构建或模拟测试通过表述为 Telegram 完成。

当前 Sites 运行时先通过不含凭据的受限探针验证 Telegram TCP 可达性。若实测证明 Worker 无法稳定承载跨请求登录会话，则 Site 改为服务端调用仅所有者可访问的私有 MTProto 后端；不会删除个人 API。

## 仍由 Windows 桌面端独占

- 123AV 查询、Chrome 扩展和账号收藏。
- 本机浏览器会话、任意目录读写与 Windows DPAPI 存储实现。

## 数据迁移

第一版禁止直接导入正式 SQLite：

1. 在 Windows 桌面端导出并脱敏为 JSON 或 CSV。
2. 至少保留 `tool`、`recordKey`、`primaryValue`；可选字段包括 `status`、`tags`、`actressTags`、`genreTags`、`sourceUrl`、`missavUrl`、`av123Url`。
3. 在“数据迁移”选择文件，先核对原始行、可导入行、拒绝/重复行、工具分布与 SHA-256。
4. 确认后才会按 100 条一批写入 D1。
5. 如数量或内容不符，在迁移批次中执行回滚；新增记录会删除，被覆盖记录会恢复原值。

不要把 Windows Telegram 会话、正式 SQLite 或未脱敏原始归档上传到网站。`TELEGRAM_API_ID`、`TELEGRAM_API_HASH`、`TELEGRAM_BOT_TOKEN` 和 Session 加密密钥只能配置在 Sites Secrets 或所有者私密配置中；手机号、验证码、两步验证密码和二维码内容只允许在所有者登录流程中短时使用。

## 开发与验证

需要 Node.js `>=22.13.0`：

```bash
npm run install:ci
npm run db:generate
npm run lint
npm test
npm run validate:artifact
```

`npm test` 会构建 Vinext/Cloudflare Worker 产物并运行 v0.5.13 规则回归测试。D1 绑定名在 `.openai/hosting.json` 中固定为 `DB`；正式数据库由 Sites 提供。

## 目录

- `app/`：响应式工作台与 API 路由
- `lib/rules.ts`：可在浏览器运行的 v0.5.13 兼容规则
- `lib/server-store.ts`：D1 持久化、分页、批量操作、迁移与导出
- `db/`、`drizzle/`：D1 表结构和迁移
- `tests/`：规则与部署产物回归测试

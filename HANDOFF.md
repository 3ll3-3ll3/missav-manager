# Telegram 工具箱总控交接

更新日期：2026-08-12

## 当前 Git 状态

- 仓库：`3ll3-3ll3/missav-manager`（本地工作树位于 `E:\Desktop\codex项目\missav-manager`）
- 当前分支：`codex/sites-private-web`
- 本次交接起点提交：`dce289ad5fb085aaf63940f268310ef73ce4acef`
- 本次提交范围：仅本文件 `HANDOFF.md`
- 工作区状态：已有未跟踪的网站源码目录 `apps/web-site/`。本次不吸收、不覆盖、不回退该目录；它必须由云端任务单独核对。

## 本次已完成内容

1. 已完整阅读并遵守：
   - `AGENTS.md`
   - `docs/PROJECT_HANDOFF.md`
   - `docs/CHANGELOG_2026-07-12.md`
   - `docs/CHATGPT_WORK_SITE_HANDOFF.md`
   - `README.md`
   - `使用教程.md`
   - `GPT_Work交接包_v0.5.13_20260801/HANDOFF.md`
2. 已核对稳定桌面基线约束：
   - `codex/v0.5.13-desktop-stable` 不得修改。
   - `v0.5.13-desktop-baseline` 标签不得修改。
   - 已发布的 v0.5.13 Windows Release 不得修改。
3. 已确认当前分支 `codex/sites-private-web` 符合云端工作范围；本次交接文件将只提交到该分支。
4. 当前项目资料已经明确了桌面端 v0.5.13 的 Telegram Bot、个人 API、官方导入、消息去重、工具绑定、已读策略、历史和本地加密会话语义。
5. 当前需求已经明确：Telegram 连接与会话应集中配置一次；每个工具只选择已配置的会话和来源，不再让每个工具重复登录或重复填写 Telegram API。

## 交给云端的下一项具体任务

请在允许的云端分支 `codex/sites-private-web`（如需隔离任务，也可新建 `codex/cloud/<任务名>`）上继续完成网站实现。不得只返回方案，必须做到可运行、可测试、可部署。

### A. 建立全局 Telegram 连接中心

新增一个独立的 Telegram 设置/连接中心，统一管理：

- 个人账号 MTProto 会话：`api_id`、`api_hash`、手机号、二维码登录、验证码、2FA 和加密 Session。
- Bot API 会话：Bot Token 只从已有 Site Secret 读取，不允许输入框回显或写入仓库。
- 连接状态、最近验证时间、失效、重连、注销和错误诊断。
- 会话/凭据只配置一次，不能让工具页再建立第二套登录流程。

个人 API 必须保留为网站能力；不能按旧文档把它错误地限制为 Windows 本地功能。Secret 只能来自 Site Secrets，Session 使用服务端密钥进行信封加密，日志和前端不得出现凭据、验证码、二维码 URL、Token 或完整 Session。

### B. 工具选择会话和来源

每个工具（推特、Bad.news、海角、MissAV、123AV）进入输入页后，只显示：

- 可用 Telegram 会话下拉框。
- 该会话可访问的群组、超级群组和频道多选列表。
- 当前工具已绑定来源、待新增来源、待移除来源。
- 明确的“当前工具”标题，避免把来源错绑到别的工具。

同一来源可以绑定多个工具；同一工具可以绑定多个来源；保存一个工具的绑定不能覆盖其他工具的绑定。Bot 和个人 API 都进入同一统一消息池，不能按工具各自推进一个 Bot `getUpdates` 游标。

### C. 统一消息池和独立工具队列

实现并测试：

- Bot、个人 API、官方 JSON/HTML 导入共用规范化消息模型。
- 频道/超级群组优先使用 `peer_type + peer_id + message_id` 去重；普通群组/私聊必要时加入连接身份。
- Bot offset、原始消息、指纹、所有工具队列、同步审计必须在同一事务内提交。
- 同一消息可分发给多个工具，但每个工具的 `pending`、`completed`、`processed_empty`、`ignored`、`error` 状态完全独立。
- 编辑消息使用版本/哈希重新提取；删除消息保留 `remote_deleted` 证据，不硬删处理历史。

### D. 同步和已读语义

实现后必须明确区分：

- 只读取，不标已读。
- 增量安全入库后标已读。
- 手动确认后标已读。

安全自动标已读只能在消息落库、所有绑定工具队列建立、事务提交且同步区间连续后执行。历史回拉永不自动标已读。必须保存接收高水位、连续同步点、最后标已读点和已读基线，不能用一个 checkpoint 混代。

增量恢复不能只依赖一个易失分页游标；至少要保留来源级高水位、重叠校对页、错误状态和可恢复任务。普通 Worker 请求不能跨请求复用 MTProto Socket；需要长期连接时使用 Durable Object/队列/定时任务，不能把“TCP 可达”当成“Telegram 已经可用”。

### E. 云端验收

在报告“完成”前必须真实验证：

1. 个人 API 二维码或手机号登录至少成功一次。
2. 刷新/重新部署后加密 Session 可继续使用。
3. 连接中心能分页发现群组、超级群组和频道。
4. 两个工具共用同一个 Telegram 会话时不重复登录。
5. 同一来源绑定两个工具后，消息只接收一次、队列各自独立。
6. Bot 重复拉取不重复入库，且没有 Webhook/getUpdates 冲突。
7. 编辑、删除、断网、限流、Session 失效都有明确可恢复状态。
8. 三种已读策略分别验证，并证明历史回拉不会标已读。
9. 非所有者访问被拒绝，Secret 不出现在前端、日志、数据库明文或错误堆栈。

## 必须检查的文件

开始云端修改前必须重新阅读：

- `AGENTS.md`
- `docs/PROJECT_HANDOFF.md`
- `docs/CHATGPT_WORK_SITE_HANDOFF.md`
- `docs/TELEGRAM_SOURCE_DESIGN.md`
- `apps/desktop-v05/src/components/SourcesView.vue`
- `apps/desktop-v05/src/components/TelegramToolWorkspace.vue`
- `apps/desktop-v05/src-tauri/src/workspace.rs`
- `apps/desktop-v05/src-tauri/src/telegram_user.rs`
- `src/telegramBot.js`
- `src/telegramClient.js`
- `src/telegramSource.js`
- `test/telegram-bot.test.js`
- `test/telegram-client.test.js`
- `test/telegram-database.test.js`
- `test/telegram-source.test.js`

如果云端只存在 `apps/web-site/`，还必须检查其认证、数据库、迁移、Secret、API 路由和测试文件，并把桌面端语义逐项映射，不得只复制界面。

## 禁止修改的文件、分支和外部数据

- 禁止修改、重写、删除或强推：
  - `codex/v0.5.13-desktop-stable`
  - `v0.5.13-desktop-baseline`
  - 已发布的 v0.5.13 Windows Release
- 云端任务只能在 `codex/cloud/<任务名>` 或 `codex/sites-private-web` 上进行。
- 本次不得把工作区现有的 Electron/Tauri/桌面端未提交改动顺手提交。
- 禁止提交正式 SQLite、`-wal`、`-shm`、Telegram Token、`api_hash`、手机号、验证码、2FA 密码、Session、Cookie、Local/Session Storage、个人黑名单和其他 Secret。
- 不得把 Raindrop API、123AV 登录或本地 Chrome 能力伪装成网站已完成能力。
- 不得使用正式数据库做测试，不得执行 `git reset --hard`、`git checkout --` 或强制覆盖用户修改。

## 测试命令

桌面端及根目录测试必须使用临时数据库/隔离用户目录：

```powershell
cd E:\Desktop\codex项目\missav-manager\apps\desktop-v05
npm run check
npm run test:rust
npm run build:web

cd E:\Desktop\codex项目\missav-manager
npm test
git diff --check
```

云端网站还必须执行其实际可用的：

```powershell
npm run lint
npm run test
npm run build
```

如果脚本名称不同，必须在交付说明中列出实际命令和结果；禁止用“已测试”替代输出。涉及 UI 时必须做桌面、窄屏/移动端和刷新恢复验收。

## 明确完成标准

只有同时满足以下条件，云端任务才能标记完成：

- 全局 Telegram 连接中心可配置和验证个人 API 与 Bot；工具不重复登录。
- 多来源、多工具绑定可视、可搜索、可增删，且不会错绑或互相覆盖。
- Bot、个人 API、官方导入共用统一消息池、强去重和原子分发。
- 同步断点、编辑/删除、三种已读策略和失败恢复均有真实测试。
- 个人 API Session 安全加密，Secret 不泄漏，所有者之外无法访问。
- 网页刷新、重新登录、重部署后连接配置和业务数据语义保持一致。
- 自动测试、构建、权限测试和至少一轮真实端到端验收全部通过。
- 报告中明确列出网站已完成能力、仍留在 Windows 的能力、已知限制和回退方式，并给出对应提交号和部署来源。

## 当前阻塞点

1. `gh auth status` 仍显示账号 `3ll3-3ll3` 的 GitHub CLI Token 无效；本次 Git 推送已通过现有 Git 凭据管理器成功完成，但后续如果需要用 `gh` 创建 PR、读取检查或调用 GitHub API，必须先重新执行 `gh auth login -h github.com`。
2. 当前工作区有未跟踪的 `apps/web-site/` 网站源码；本次没有对其做完整来源审计，云端不得假设它已经提交或已验收。
3. 个人 API 网站端的真实登录、Session 重载、来源发现、增量接收和远端已读仍需在云端环境用测试账号完成端到端验收；不能只凭 TCP/WSS 可达或登录页面存在宣布完成。
4. Bot Token、个人 API 凭据和正式 Telegram 数据均未提供，也不应通过聊天提供。云端只能读取已有 Site Secrets，并用合成/脱敏夹具完成自动测试。

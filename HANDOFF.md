# Telegram 工具箱总控交接

更新日期：2026-08-12

## 本轮任务卡（云端 Work 必读）

- 本轮任务名：`telegram-session-center-web`
- 基线分支：`codex/sites-private-web`
- 基线提交：`53011e24586c55ba7bc644fea485d9faf40ca340`（GitHub 当前已知最新网站提交）
- 需要修改的功能：全局 Telegram 连接/会话中心；个人 Telegram API 与 Bot 会话统一配置；二维码/手机号登录与加密 Session 恢复；群组、超级群组、频道发现；每个工具选择已配置会话和来源；来源多对多绑定；统一消息池、跨入口去重、事务分发、断点恢复、编辑/删除处理和三种已读策略。
- 允许修改的文件：`apps/web-site/**`、本文件 `HANDOFF.md`；如确实需要修改仓库根目录构建入口，必须先在报告中说明原因、影响和验证结果，不得顺手修改桌面端。
- 禁止修改的文件：`apps/desktop-v05/**`、根目录 Electron 兼容端、稳定分支相关文件、正式数据库、任何 Secret、以及 `AGENTS.md`、`docs/PROJECT_HANDOFF.md`、`docs/CHATGPT_WORK_SITE_HANDOFF.md` 中已确定的桌面基线内容。
- 测试命令：`cd apps/web-site; npm run lint; npm test; npm run build`；完成后在仓库根目录运行 `git diff --check`。依赖安装若被缓存/权限阻断，必须记录具体错误，不得假报通过。
- 完成标准：个人 API 与 Bot 都能在一个全局连接中心配置一次；工具页不重复登录；来源发现、绑定、统一去重、原子分发、编辑/删除、断点恢复和三种已读策略均有自动测试和至少一轮真实端到端验收；刷新/重部署后 Session 和业务数据仍可用；非所有者不能访问；Secret 不出现在前端、日志、数据库明文或错误堆栈；私人 Site 可构建、部署并给出可追溯提交。
- 线上版本18源码是否已同步到 GitHub：**否，尚未证明同步**。云端核对报告称线上 v18 与 GitHub `53011e2` 源码不同步；不得把线上 v18 反向覆盖 GitHub，必须先获取可核对的部署提交/构建产物哈希，再决定是否迁移差异。
- 目标分支：`codex/cloud/tg-session-center-handoff`

当前任务边界：本轮先完成 Telegram 全局连接中心和工具绑定闭环；MissAV 过滤规则、123AV 本地账号操作、Chrome 扩展、Windows DPAPI 和 Raindrop API 不属于本轮网站修改范围，不能伪装为已迁移。

## 云端执行状态（2026-08-12）

### 线上 v18 与 GitHub 基线核对

- 已取得线上版本 18 的可追溯来源提交：`72ab03fc841f1c67b18eab8e87ef8a083a498259`。
- 已取得版本 18 源码归档哈希：`sha256:b5a2ba9e1a42904d9023ecd7dc55be4577d0494c86a3aeb1774e58e92ad810d6`，归档共 35 个文件。
- 已确认版本 18 与 GitHub 基线 `53011e24586c55ba7bc644fea485d9faf40ca340` 并非同一源码；本次先按文件哈希核对差异，再只把 `apps/web-site/**` 内构成可构建网站所需的差异和本轮修复提交到目标分支。未使用线上版本覆盖仓库根目录或桌面端。
- 线上版本 18 仍保持原部署状态，本提交没有创建 Sites 检查点或生产部署。

### 本轮网站实现

- 全局 Telegram 中心统一承载 Bot 与个人账号状态；工具页面只选择已永久绑定的来源，不包含登录、Token 输入或独立 `getUpdates`。
- 个人账号支持二维码、手机号、验证码、2FA、加密 Session 恢复；验证码挑战与 Session 均使用服务端 AES-GCM 密钥加密，手机号、验证码、密码、二维码内容不持久化。
- Sites Worker 明确采用请求级 MTProto 重连并在请求结束时断开，不再把端点可达或 Session 存在描述成常驻连接。
- 会话库只发现群组、超级群组和频道；最多展示 100 个来源，截断刷新不会把未展示来源误标为失效。
- Bot 使用单一全局 offset 和锁；拉取前检查 webhook 冲突，私聊更新被过滤。
- 统一消息池以来源与消息 ID 去重；同一消息只保存一次，并向每个已绑定工具建立独立队列。编辑会更新正文并把已有工具队列重置为待处理；删除保留墓碑并传播 `deleted` 状态；重复删除不会重复计数。
- 连续增量检查点、历史游标、接收高水位、安全已读点和最后远端已读点分离；最近、范围和历史回拉不会推进连续增量检查点，历史回拉不会自动标已读。
- 手动已读只能使用已安全入库的边界；`never`、`safe_auto`、`manual` 三种策略均保留独立语义。
- 新增 D1 迁移 `0004_classy_pixie.sql`，清理旧版明文验证码挑战并增加同步、生命周期、Bot webhook 与断点字段。

### 已完成验证

- `cd apps/web-site && npm run lint`：通过。
- `cd apps/web-site && npx tsc --noEmit`：通过。
- `cd apps/web-site && npm test`：通过，36/36；测试过程包含生产构建与 Sites 产物校验。
- `cd apps/web-site && npm run build`：通过。
- 仓库根目录 `git diff --check`：通过。
- 私有 Agent Preview 浏览器验收：全局连接、会话库、工具绑定、同步记录与工具侧本次来源选择可正常导航；工具页面未出现重复登录或 Bot 拉取入口；页面源码没有前端运行错误。
- 集成测试使用临时 SQLite/D1 适配器执行全部迁移，验证一个来源只落一份消息、两个工具各有独立队列、重复不重入、编辑重置双队列、删除传播和重复删除幂等。
- 生产身份守卫、Secret 仅服务端读取、敏感登录状态不持久化均有自动测试。

### 尚未满足的真实验收门禁

- Agent Preview 不注入正式 Site Secrets，且用户要求真实端到端验收后再部署，因此本轮没有创建新的生产部署，也不能据此宣称 Telegram 登录已真实成功。
- 仍需由网站所有者在可访问真实 Site Secrets 的受控环境完成：个人账号二维码或手机号登录、刷新后 Session 恢复、真实来源发现、同一来源向两个工具投递、Bot 重复拉取、编辑/删除、三种已读策略、故障恢复，以及重新部署后的持久化验证。
- 当前 Sites 能力只提供 D1/R2，没有 Durable Object、队列或定时任务；个人 MTProto 因此是按操作短连接，不是跨请求常驻监听。若验收要求持续实时监听，必须另增具备长生命周期的私有后端或平台能力，不能把当前模式标成常驻连接。
- 真实 E2E 通过前，本任务状态为“代码与自动化验收完成，生产部署待验收”，草稿 PR 不应合并。

### 未修改范围

- `codex/v0.5.13-desktop-stable`、`v0.5.13-desktop-baseline`、Windows Release、`apps/desktop-v05/**`、根目录 Electron 兼容端及正式数据库均未修改。


## 当前 Git 状态

- 仓库：`3ll3-3ll3/missav-manager`（本地工作树位于 `E:\Desktop\codex项目\missav-manager`）
- 当前分支：`codex/cloud/tg-session-center-handoff`
- 云端网站基线提交：`53011e24586c55ba7bc644fea485d9faf40ca340`（`origin/codex/sites-private-web` 最新提交）
- 当前网站实现提交：`356d48c9cf9e999d963d5716d2f84355177fc64a`（30 个 `apps/web-site/**` 文件与本交接文件）
- 网站源码状态：已完成 v18 来源审计和逐文件哈希核对；目标分支已纳入可构建的 `apps/web-site/**` 实现，未修改桌面端。

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
3. 已以 `codex/sites-private-web` 的 `53011e24586c55ba7bc644fea485d9faf40ca340` 为基线，在 `codex/cloud/tg-session-center-handoff` 完成网站实现；基线分支尚未合并或覆盖。
4. 当前项目资料已经明确了桌面端 v0.5.13 的 Telegram Bot、个人 API、官方导入、消息去重、工具绑定、已读策略、历史和本地加密会话语义。
5. 当前需求已经明确：Telegram 连接与会话应集中配置一次；每个工具只选择已配置的会话和来源，不再让每个工具重复登录或重复填写 Telegram API。

## 后续真实验收与部署任务

网站代码与自动化验收已完成。下一步只在网站所有者确认真实 Telegram E2E 清单通过后，才允许创建 Sites 生产检查点、验证部署状态并决定是否把草稿 PR 合并到 `codex/sites-private-web`。

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

1. 真实 Telegram 凭据不应通过聊天提供；Agent Preview 也不注入正式 Site Secrets，因此个人账号登录、Bot 身份、真实来源与远端已读尚未执行。
2. 用户明确要求真实端到端验收后再部署；Sites 的 checkpoint 本身就是生产部署，因此当前不能用 checkpoint 充当预部署测试环境，线上 v18 必须保持不变。
3. 仍需网站所有者确认：二维码或手机号登录、刷新后 Session 恢复、真实来源同步、同一消息跨两个工具独立排队、Bot 重拉幂等、Webhook 冲突、编辑/删除、三种已读策略、断网/限流/Session 失效与重新部署后的持久化。
4. 当前 Sites 无 Durable Object、队列或定时任务；如必须持续实时监听 MTProto，需要另增私有长生命周期执行环境。当前实现只承诺请求级短连接。

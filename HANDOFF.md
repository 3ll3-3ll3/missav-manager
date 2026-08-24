# TG 内容工具箱：本地与云端统一主线交接

更新日期：2026-08-24

## 0. 当前统一主线（本轮）

- 当前工作目录：E:\Desktop\codex项目\tg-toolbox-unified
- 当前分支：codex/unified-local-cloud-v1
- 当前本地 HEAD：74807b3e18458c5a6f40ec31ee59ef2b8dc6b116（尚未推送时，远端仍可能停在 20486209ab20163d8cbd20f26a075da415c4d68f）。
- 起始基线：origin/codex/cloud/web-ux-parity-v0513 的 38fed1d3c177c1a62ec193ea09664b457a7cd33e
- 本轮在独立 worktree 工作；原 missav-manager 脏工作树未覆盖、未 stash、未 reset。
- 受保护基线 codex/v0.5.13-desktop-stable、标签 v0.5.13-desktop-baseline、Windows Release、既有 EXE 和正式数据库均未修改。

### 已完成

1. 新增共享同步协议 packages/sync-contract：统一自然键、幂等操作、批次限制、Secret 拒绝、墓碑、checkpoint 单调合并和队列状态冲突规则。
2. 新增独立 Cloudflare Worker/D1 同步网关 apps/sync-service：
   - 一次性设备配对与可撤销设备；
   - 增量 Push/Pull 和全局序列；
   - 实体快照、冲突、节点游标；
   - Telegram 来源级执行租约；
   - Miniflare+D1 集成测试覆盖配对、幂等、Push/Pull、租约、Secret 拒绝、单实体冲突读取和墓碑显式恢复。
3. Windows 新增一级“同步”入口：
   - 网关连接测试与一次性配对；
   - 设备 Token 通过 Windows DPAPI 独立加密文件保存；
   - 本地同步状态、实体镜像、outbox 和冲突表；
   - 真实差异预览；
   - 仅 Push、仅 Pull、双向同步；
   - 30 分钟预览有效期、预览后两端变化拒绝、执行前自动备份；
   - 按数量和请求体大小分批上传/下载、删除墓碑、断点游标和本地冲突留痕；
   - 冲突逐条“采用云端/保留本地”，处理前自动备份；从墓碑恢复必须明确选择保留本地。
4. Windows v1 业务适配已覆盖 11 类：永久记录、处理批次、结果明细、任务中心、Telegram 来源、工具与来源绑定、统一 Telegram 消息、各工具独立队列、Telegram checkpoint、三种已读策略及位置、MissAV 三份规则资料。超大原始输入只同步前 64 KiB 预览，完整原文仍保留在创建它的执行端。
5. Windows 的 Bot 增量、个人账号增量、历史回拉和标已读调用链均接入远端来源租约；续约失败时拒绝提交本次结果，不推进本地 checkpoint、Bot offset 或已读位置。
6. 架构与云端提示词：docs/UNIFIED_LOCAL_CLOUD_ARCHITECTURE.md 与 docs/WORK_UNIFIED_CLOUD_PROMPT.md。
7. Sites 网站已完成本轮同步代码接入：
   - D1 新增同步状态、运行抑制、dirty、outbox、实体版本和冲突表，业务表由同事务触发器登记变更；
   - 既有数据首次初始化会进入安全种子队列，Pull 写入通过抑制标记避免形成同步回声；
   - 网站服务端完成设备自动配对、设备凭据 AES-GCM 加密保存、真实预览、Push、Pull、双向同步、墓碑删除、断点游标、冲突查看/重试/逐条取舍；
   - 一级导航新增“同步”，浏览器只看到脱敏状态，不接触管理员 Token 或设备 Token；
   - 网站 Bot、个人账号增量/历史、工具内同步及标已读均接入跨端来源租约；有效租约不允许强抢，续约失效拒绝推进远端状态；
   - 新增 `0006_spicy_omega_sentinel.sql`，生产构建已包含该 D1 迁移。
8. 网站同步集成测试通过真实内存 D1 和实际同步 Worker 验证：网页 Push、另一端 Pull、远端写入回拉、墓碑删除、冲突采用远端、5,001 条分批生成 outbox、设备凭据不返回浏览器，以及同一 Bot offset 的跨端互斥。
9. 最终调用链审计发现并修复过一项跨端租约键差异：网页和 Windows 现在都使用 `telegram:bot:global-offset` 及 `telegram:personal:<external-chat-id>`；集成测试直接用“另一台 Windows 设备会请求的键”验证 Bot 与个人来源均返回冲突。
10. 根据云端部署前审计，已关闭四项新阻断：
    - Telegram 来源跨端自然键统一为 `telegram_personal:default:<external-chat-id>` / `telegram_bot:default:<external-chat-id>`；网页的 `telegram-personal`、`telegram-bot` 仅作为本地连接别名，Pull 会复用既有来源 ID，不再生成重复来源；
    - 网站 Push 同 Windows 一样按实际 UTF-8 JSON 请求体切分到 3.5 MB 安全目标，单条超限明确报错，合法大批次不会被 Worker 的 4 MB 硬上限拒绝；
    - Secret 防护除字段名外增加字符串内容识别，覆盖 Bot Token、Bearer、Telegram 登录链接及敏感键值文本，错误不回显原值；
    - Bot offset 与个人 checkpoint 在最终数据库提交前再次验证远端租约；续租会刷新到期时间，距到期不足 5 秒拒绝提交，`safe_auto` 远端已读前也再次验证。
11. 根据第二轮云端复核，又关闭两项最终阻断：
    - Bot 消息分块写入完成后、最终 offset/状态批次提交前再次验证远端租约；若此时租约失效，已写消息保留并由唯一键支持幂等重试，但 offset 保持原值且同步运行记为失败；集成测试真实模拟“消息已经入库后租约失效”。
    - 网站 Push/Pull 不再依赖静默硬分页上限。每次服务端请求只处理有界批次并明确返回 `incomplete`、`remaining` 与 `hasMore`；浏览器重新生成预览后自动续跑，关闭页面后未处理 outbox 仍保留。分段未完成不会更新最近成功时间，十万条不会在约 26,500 条后假报成功。
12. 根据第三轮云端复核，修复 Pull 后续分页失败的成功时间语义：
    - `applyPulledPage()` 现在只原子提交业务数据和 `last_pulled_sequence`，不再逐页更新 `last_success_at`；最近成功时间只在整个 Push/Pull 真正结束的统一出口写入。
    - 新增真实网关回归：第一页 50 条成功落库、第二页模拟网络失败后，已完成断点和 50 条数据保留，`last_success_at` 保持执行前原值，`last_error` 记录失败。
13. Windows 同步执行器完成失败恢复与协议防卡死加固：
    - 任一 Push/Pull/预览校验失败都会持久化脱敏、限长的 `last_error`，保留既有成功时间、Pull 游标和已完成分批，同时作废旧预览；UI 明确要求重新预览后继续。
    - Push 要求网关对本批每个 `operationId` 恰好确认一次；空确认、漏确认、重复确认或批外确认会立即停止，不再无限重复同一批。
    - Pull 校验操作序列、`next_sequence`、`latest_sequence` 与 `has_more` 的一致性；有后续页但游标未前进会立即停止，不再无限请求同一页。
    - 仅 Push 且本地无待上传项时不再把已知远端序列误写回 `0`；成功后完整清除预览 ID、哈希、远端序列和预览时间。
14. Windows 首次汇合、双向冲突与大批量性能完成第二轮加固：
    - 新设备不再从序列 0 重放云端全部历史，而是使用当前实体快照建立基线；数据库新增 `bootstrap_completed` 明确记录首次汇合状态，不能再用“游标是否为 0”误判空云端。
    - 首次 Pull 以云端为准，首次 Push 以本地为准且绝不删除云端独有行；首次双向同步互补两端独有行，同键不同内容进入逐条冲突，远端墓碑恢复必须显式确认。
    - 日常双向同步改为先 Pull 后 Push；同一实体两端都变化时，本地 outbox 立即改为 `conflict`，不会继续上传并覆盖云端。
    - 未处理冲突不会被下一轮本地扫描重新排队；同一冲突不会重复插入多条开放记录。
    - 本机刚 Push 成功的数据在下一轮 Pull 中若载荷已与实体镜像一致，只推进云端版本与游标，不再重复改写业务表；十万条首传后不会再产生同规模本地重写。
15. Windows 同步中心体验与版本标识对齐：
    - 正式同步网关地址默认预填，配对后仍可独立测试连接并显示检查时间。
    - 预览补充远端删除标记、实体类型明细、方向建议和包含完整数量的执行确认；首次汇合状态在当前节点区直接可见。
    - 统一主线正式升为 `v0.6.0`；保留原应用 identifier 和数据目录以兼容 v0.5.13 数据，受保护的 v0.5.13 分支、标签、Release 与 EXE 均未修改。

### 本轮最终自动验证

- 网站：TypeScript、ESLint、Vinext 生产构建通过，`90/90` 项测试通过；新增真实网关分块、显式续跑、Pull 后续分页失败、来源复用及消息写入后租约失效回归，构建路由含 `/api/cloud-sync`，产物含 `0006` 迁移。
- 同步 Worker：语法检查、`7/7` 项 Miniflare+D1 测试、Wrangler dry-run 通过；随后正式 Worker/独立 D1 已部署并执行 `0001_initial.sql`，公开健康接口和隔离设备协议 E2E 通过。
- 仓库总回归：`242/242` 项测试通过，根目录语法检查通过。
- Windows 统一版：Vue/TypeScript/Vite 构建和 Tauri release 应用构建通过；Rust `cargo check` 通过，`37/37` 项常规测试通过、1 项真实网关 E2E 默认忽略。另已在隔离临时 SQLite 与一次性设备上实际通过“配对→预览→首次 Pull→断开”，测试配对记录清零且设备已撤销。
- `git diff --check` 通过；凭据模式扫描只命中既有安全测试中的明确假 Token 夹具，未发现正式 Secret。

### 尚未完成，不得提前宣称

- 正式同步 Worker/D1 已部署，Worker `0001_initial.sql` 已执行，健康接口和设备协议已由 Windows 隔离 E2E 验证；但生产 Site v26 尚未接入同步页面与 `0006` 数据表，因此正式网站和 Windows 仍不能业务互通。
- `0006_spicy_omega_sentinel.sql` 尚未在正式 D1 执行，未导入或改写任何正式数据。
- 真实网站↔Windows 首次汇合、断网续传、十万条正式数据与 Telegram 登录/收发 E2E 尚未验收。
- Site 的 `SYNC_GATEWAY_URL` 与遮蔽的 `SYNC_ADMIN_TOKEN` 环境项已经设置，但当前生产仍是 v26；不能据此描述成“网站同步已上线”。
- 云端普通 Work 对话没有挂载当前正式 Site，本身无法读取 v26 的实际源码树；应从 Sites 列表点击当前站点的编辑图标进入带 Site 引用的对话。不能从 GitHub 旧 SHA 猜测生产基线并覆盖线上修复。

### 下一步交给云端

云端下一步必须从 Sites 列表点击当前 TG 内容工具箱的编辑图标，在自动挂载正式 Site 的对话中执行；不得在普通 Work 对话里猜测生产源码：

1. 先只读确认当前正式生产确为 v26，并从 Site 引用读取实际源码树；若无法确认，立即停止。
2. 把 v26 实际源码完整保存到 `codex/cloud/v26-database-backup-center`，建立可追溯的 Git 基线；不得用 GitHub 旧分支反向覆盖 Site。
3. 本轮只制作“数据库备份与恢复中心”过渡版本：覆盖当前 25 张表、加密 Session 只作不透明密文、备份清单/校验/下载/临时 D1 恢复演练/十万条验证。
4. 本过渡版本的构建产物不得包含或执行 `0006_spicy_omega_sentinel.sql`，不得启动首次同步，不得改变任何现有 Secret。
5. TypeScript、ESLint、全测试、生产构建、临时 D1 恢复演练全部通过后，先保存候选版本并人工核验；确认无误后才部署该备份中心过渡版本。
6. 只有备份中心在生产完成真实备份并验证可恢复后，下一轮才允许从同一实际 Site 源码合并统一同步、执行 0006 和完成双端 E2E。

### 云端必须检查

- docs/UNIFIED_LOCAL_CLOUD_ARCHITECTURE.md
- docs/WORK_UNIFIED_CLOUD_PROMPT.md
- packages/sync-contract/index.js
- apps/sync-service/src/index.mjs
- apps/sync-service/migrations/0001_initial.sql
- apps/web-site/lib/cloud-sync-schema.ts
- apps/web-site/lib/cloud-sync.ts
- apps/web-site/app/api/cloud-sync/route.ts
- apps/web-site/app/components/cloud-sync-center.tsx
- apps/web-site/drizzle/0006_spicy_omega_sentinel.sql
- apps/web-site/lib/server-store.ts
- apps/web-site/lib/server-telegram.ts
- apps/web-site/lib/server-mtproto.ts
- apps/web-site/lib/telegram-sync-commit.ts
- apps/web-site/app/workbench.tsx
- apps/web-site/tests/cloud-sync-schema.test.mjs
- apps/web-site/tests/cloud-sync-integration.test.mjs
- apps/web-site/tests/telegram-delivery-integration.test.mjs

### 禁止修改

- codex/v0.5.13-desktop-stable
- v0.5.13-desktop-baseline
- 现有 Windows Release/EXE
- 正式 SQLite/D1 数据
- 任何 Telegram/Raindrop Token、API Hash、Session、Cookie、密码或 .env 值

### 本轮验证命令

    node --test test/sync-contract.test.js
    cd apps/sync-service
    npm ci
    npm run check
    npm test
    $env:WRANGLER_LOG_PATH='.wrangler/wrangler.log'
    npm run deploy:dry -- --config wrangler.example.jsonc
    cd ../desktop-v05
    npm ci
    npm run build:web
    cargo check --manifest-path src-tauri/Cargo.toml
    cargo test --manifest-path src-tauri/Cargo.toml
    cd ../..
    npm run check
    npm test
    git diff --check

### 当前完成标准

- 本轮代码提交与推送后，云端 Work 可从单一分支读取协议、网关、桌面和网站实现。
- 不需要真实 Secret 的单元、集成和构建验证全部通过。
- 生产 Site 尚未接入同步时不得把同步描述为已上线；首次正式数据同步必须由用户在差异预览后确认。
- 云端完成后必须回写真实提交、部署版本、测试结果和待用户 E2E，不能用“构建通过”替代外部验收。

### 当前阻塞点

- 正式 Worker/独立 D1 已部署，Site 所需 `SYNC_GATEWAY_URL` 与遮蔽的 `SYNC_ADMIN_TOKEN` 也已配置；不得重复创建或要求用户把值发给 Work/Codex。
- 生产 Site v26 的实际源码树尚未形成可解析的 Git 基线；必须先从挂载 Site 的编辑上下文恢复并固定源码，不能用旧 Git 分支覆盖生产。
- 正式 Site D1 尚未执行 `0006`。执行前必须先完成 25 张表的完整备份、校验、临时 D1 恢复演练和可恢复性证明。
- 备份过渡版验收后，才允许合并统一同步代码、执行 `0006`，并完成网站与 Windows 的脱敏双端 E2E；首次正式汇合仍只生成预览并等待用户确认。

### 2026-08-24 Site v27 备份中心候选审计

- 云端已从实际 Site v26 保存候选分支 `codex/cloud/v26-database-backup-center`，Git 提交 `37a69c8a969f5f3b06d0b6974fa9f1833e6a5bca`，Sites 候选 v27 已保存但未部署；正式生产仍为 v26。
- 候选不含 `0006`，TypeScript、ESLint、生产构建、25 表备份校验和 10 万行内存临时 SQLite 恢复测试通过。Windows 隔离复核中构建和备份测试通过；其余 5 个测试因测试帮助器在含中文 Windows 路径上生成重复盘符而失败，属于测试可移植性问题，不能改写成业务测试通过。
- **候选暂不批准部署。** 当前恢复实现逐表 `DELETE`，再以多个独立 `db.batch()` 分批插入；每个 batch 只保证自身事务性，整个 25 表恢复不是单一原子事务。任一中途错误都可能让正式 D1 处于部分清空、部分恢复状态。
- 清单接口当前会先把 25 表全部行读入 Worker 内存；恢复接口允许最多 96 MB JSON 并同时持有原始文本、解析对象和写入批次。10 万行 Node/SQLite 测试不能证明正式 Workers/D1 的 CPU、内存和请求限制下安全。
- v27 修复方向：生产 Site 过渡版只开放只读清单、下载和校验；禁用正式库原地恢复。正式灾难恢复优先记录并使用 D1 Time Travel bookmark；JSON 恢复只对全新临时 D1 演练，验证后再决定受控切换。备份生成应由用户显式触发，避免页面加载自动全库扫描，并增加真实 Workers/D1 大数据与中途失败回归。

### 2026-08-24 Site v28 备份中心候选审计

- 云端候选分支仍为 `codex/cloud/v26-database-backup-center`，Git 提交 `34ea3b940454b4a302c711606feceef70b686045`；Sites v28 已保存但未部署，正式生产仍为 v26。
- Windows 隔离 worktree 已复跑生产构建与全部测试，`59/59` 通过；中文 Windows 路径重复盘符问题已修复。候选产物仅含 `0000`～`0004`，未包含 `0006` 或 `cloud_sync_*`。
- v27 的生产原地恢复风险已关闭：生产 API 只保留清单、备份下载和只读校验；生产源码不含 `DELETE/INSERT/UPDATE/REPLACE` 恢复路径，恢复只在全新且 25 表全空的临时 D1 测试夹具中存在。
- **v28 仍暂不批准部署。** 生产备份实现仍在单次 Worker 请求中完成 25 表双遍扫描。即使 25 表全空也至少执行 100 次 D1 查询；10 万行、250 行每页时约为 900 次。Cloudflare D1 每次 Worker invocation 的读请求上限为 Free 50 / Paid 1000：免费限制下备份必然失败，付费限制下也几乎没有超过 10 万行的增长余量。Miniflare 的 10 万行通过不会自动模拟该生产上限。
- 清单页本身也恰好执行 50 次查询（25 次 `PRAGMA table_info` + 25 次 `COUNT(*)`），对 Free 上限零余量，需合并或拆分。
- 下一候选应改为浏览器驱动的多请求只读备份作业：每次请求严格低于 50 次 D1 查询，按表与主键游标续传，使用字节上限而不是固定 250 行分页，不在正式 D1 中写任务状态。增加“每请求查询数上限”测试，并在 Sites 候选环境完成真实 D1 下载、中断续传和文件复校后才能部署。
- 备份 API 当前只验证“已登录 ChatGPT 用户”。正式 Site 必须继续保持平台 owner-only，部署前再次核对 1 名所有者、0 外部访客、0 群组；未改为服务端所有者允许列表前，不得开放共享。

---

# 历史交接：Web UX v0.5.13 对齐（非当前状态）

> 以下内容只保留用于追溯旧网站实现。它不能覆盖本文顶部“当前统一主线”，不能用于判定当前开发分支、当前迁移编号、基础设施状态或下一步。当前 Work 必须以 `codex/unified-local-cloud-v1`、本文顶部状态及 `docs/WORK_UNIFIED_CLOUD_PROMPT.md` 为准。

更新日期：2026-08-14

## 2026-08-14 Telegram Session 并发失效修复

- 已确认生产截图中的 `Concurrent usage of the current session...` 不是 Bad.news 规则错误，而是同一个网站个人账号 StringSession 被两个请求级连接同时恢复；Telegram 因安全策略使该 Session 失效。
- 所有会创建 MTProto 连接的路径（来源发现、工具/全局同步、手动已读、二维码/手机号登录、Session 恢复和注销）现在先取得 D1 原子独占租约。租约按操作显示、定时续期、连接断开后在 `finally` 释放；Worker 异常退出后会自动过期。第二个请求只收到中文“正在安全收尾”提示，不会再创建第二条连接。
- 工具页“安全停止”不再在浏览器终止流后立刻解锁按钮，而是读取轻量租约状态，确认服务端连接已经释放后自动刷新来源和队列。租约仍在时，界面明确说明系统继续阻止重复连接。
- `AUTH_KEY_DUPLICATED`、同 Session 并发失效和 `SESSION_REVOKED` 分开识别；页面默认只显示中文摘要。并发失效会把个人连接标记为“需要重新登录”，并在全局 Telegram 中心提供重新登录说明。
- 租约复用现有 `app_settings` 表的内部键，不新增 D1 表或迁移，不改消息、来源、绑定、结果、offset、checkpoint、已读位置或任何 Secret；内部租约键不会进入普通设置 API。
- 已被 Telegram 使失效的旧 Session 无法由代码复活。修复上线后，所有者需要在全局 Telegram 中心重新扫码或用手机号登录一次；此项仍属于待用户 E2E。

## 1. 源码与发布状态

- 工作分支：`codex/cloud/web-ux-parity-v0513`。
- 本轮真实源码基线：生产 Sites v26 对应提交 `124e80b491eb4b7a3dee5f3e8eb44aeffc317f9e`，不是按部署编号推测。
- Telegram 云端参考：PR #3 的 `codex/cloud/tg-session-center-handoff`，核对时 HEAD 为 `17fe8e2ac1a4d930d215d2cebb87916bc31c1fce`。
- GitHub PR #4 是同名网站分支；本轮开始时远端 HEAD 为 `05c46a19a5db443db46f66de0009dc319ec46504`，最终以本文件所在提交为准。
- 当前生产继续为 Sites v26；本轮只保留私人 Agent Preview，未创建 Sites checkpoint，未部署 v22 或其他生产版本。
- 未修改 `codex/v0.5.13-desktop-stable`、`v0.5.13-desktop-baseline`、Windows 标签、Release、EXE、正式 D1 或任何 Secret。

开始前已完整阅读 `AGENTS.md`、本文件、`docs/CHATGPT_WORK_SITE_HANDOFF.md`，并核对 `apps/desktop-v05` 的 App、HomeView、ToolWorkspace、TelegramToolWorkspace、SpreadsheetTable、TaskCenterView 和规则实现。

## 2. 本轮关闭的问题

### Telegram 工具页的真实动作与性能边界

- 每个工具的 Telegram 输入已拆成三个真实动作：`日常增量同步`、`加载历史`、`仅刷新本地队列`；处理所选消息是第四个独立忙碌状态。`loadMode`、每来源上限 1～100,000 和可选起止分钟进入同一服务端验证契约，结束分钟覆盖 `:59.999`。
- `incremental` 使用各个人来源连续检查点；`recent` 拉最近 N 条但不推进日常检查点；`range` 接受开始/结束任意一端；`history` 从本地最早消息继续向前。Bot 只在 `incremental` 消费账号级唯一 `getUpdates` offset，历史三模式明确跳过 Bot，不伪装成历史回拉。
- 工具页只引用全局连接、Session、Bot offset、统一消息池和来源检查点；来源卡显示连接类型、会话类型、Telegram ID、检查点、待处理/异常、上次同步/错误和本地安全/远端已读位置。绑定抽屉支持搜索并一次提交当前工具新增/移除差异，其他工具绑定不受影响。
- 远端同步、D1 入库、队列刷新、文本处理、导出和绑定分别使用独立忙碌状态。安全停止只在个人来源 200 条边界、来源并发批次边界或 Bot 已提交页边界生效，已提交 offset/checkpoint 不回退。
- 消息表默认 200 条/页，可选 50/100/200/500；支持来源、关键词、状态、起止时间、有候选和异常筛选，以及跨页选择、任务/错误列、真实候选预览、复制/TXT/CSV、忽略、恢复、异常重跑、本地测试消息和带恢复点删除。
- 默认待处理视图隐藏已清理正文、已处理空结果和无候选噪声；审计状态仍可显式查看。远端删除状态不可恢复成待处理。工具切换和刷新不会在来源加载完成前覆盖各工具保存在浏览器内的本次来源选择。
- 个人多来源仍复用一个授权客户端并保持 3 路有界并发；FloodWait 动态降到 1。单来源失败写入脱敏 `last_error` 并返回失败来源/阶段，不阻塞已安全提交的其他来源。

### Telegram 同步后 0 条可处理

根因不是 Bad.news 规则过严，而是网页只把 Telegram 可见正文交给规则，丢失了 `entities`、`caption_entities`、个人消息内联按钮、网页预览和官方 JSON 嵌套 `href/url` 中的真实链接。图片说明只有标题时，严格规则自然得到 0 个候选。

现已统一保存“可见正文 + 富文本链接 + 按钮链接 + 网页预览链接”，并同时修复秒/毫秒/数字字符串时间戳产生 `Invalid Date` 的问题。工具规则仍保持 Windows v0.5.13 的严格边界，没有把首页、广告或无关链接放宽成结果。旧消息若入库时已丢失富链接，需要由所有者在工具页执行“回拉最近 N 条”重新获取。

队列表现在显示真实候选数量与候选预览；已清理正文、已处理空结果和无候选噪声默认不出现在待处理列表。同步与处理均显示来源进度、消息数、结果数、耗时和完成状态。

### 独立工具工作区

- 首页五张卡分别直达 `#tool/twitter`、`#tool/badnews`、`#tool/haijiao`、`#tool/missav`、`#tool/av123`。
- 推特博主、Bad.news、海角使用 `输入｜结果｜历史`；MissAV 使用 `输入｜结果｜浏览器脚本｜历史`；123AV 使用 `输入｜结果｜本地任务｜历史`。
- Telegram 消息是每个工具输入页的子模式，登录和 Bot 仍只在全局 Telegram 中心配置一次。
- 五个工作区保持独立内存状态；正式保存的最新任务、结果和历史在刷新后恢复。
- “提取并保存历史”使用隐藏暂存运行和最终 D1 批量提交，同一事务语义提交运行、结果、永久记录和任务；最终提交失败不留下可见半历史。

### 结果、表格与历史

- 新增共享 `PlainOutputPanel`：各字段默认展示一行一个值的只读文本框，分别支持复制当前筛选、复制所选并显示实际行数；剪贴板失败时自动选中文本作为兜底。
- 推特分别输出博主名和主页；Bad.news/海角输出规范帖子链接；MissAV 分别输出番号和实际存在的可信来源链接；123AV 分别输出番号和已导入的有效详情链接。
- 共享结果表支持搜索、状态筛选、排序、分页、列隐藏/顺序/宽度、展开、单击/Ctrl/Shift/Ctrl+Shift、Ctrl+A/C/V、方向键、Enter、Delete、查找替换、批量修改、TSV 复制与矩形粘贴。
- 每个工具历史页可载入回本工具结果页、重命名、删除并建立恢复点，以及按 TXT/CSV/JSON 导出。
- 当前一次运行的结果工作区仍在浏览器载入该运行全部结果；全库数据中心使用服务端索引分页。面向 10 万条的“筛选条件 + 排除 ID”完整服务端选择模型仍是后续差异，见第 5 节。

### MissAV 与 123AV

- MissAV 结果可按选中或当前筛选范围进入脚本页；脚本页显示完整番号、完整只读脚本、生成时间、模板信息、参考女优 Tag、两层黑名单和三目录语义，可复制或下载 `.js`。
- 参考 Tag、第一层黑名单、第二层黑名单分别编辑、导入、导出；第一层只取消参考资格，第二层硬排除 Raindrop HTML/CSV 但保留排除报告和 JSON 审计。
- 123AV 只创建本地番号任务；任务 CSV 固定 `task_id,code,url,status`，支持只导出异常/待核验范围。结果 CSV 先预览匹配、未匹配、重复、坏行、非法状态及更新量，再确认事务写入。
- 网站没有把 123AV 标成“已查询”或“已收藏”；真实查询、Chrome 扩展和账号收藏继续属于 Windows v0.5.13。

### 处理中心与产品结构

- 品牌为“TG 内容工具箱”，一级导航只保留 `工具首页｜处理中心｜数据中心｜Telegram｜日志｜设置`，护眼淡绿且无背景图。
- 处理中心分为 `全部｜新收到｜已过滤｜待网站操作｜待复查｜异常｜已完成`，内部值与中文标签分离并分别计数。
- 表格显示 ID、阶段、工具、任务名、来源、摘要、异常、运行 ID、创建和更新时间；单选任务可打开并恢复到正确工具。
- 任务详情复用该工具的字段级纯文本输出。

## 3. 五个工具规则边界

- 推特博主：ASCII `#标签` 为主，可信 `@handle` 与 X/Twitter 主页为辅；用户名大小写不敏感去重并保持首次出现顺序。
- Bad.news：只接受 `https://bad.news/t/数字`，去掉查询参数并规范化；排除 `/app`、首页、栏目、广告和其他站点。
- 海角：只接受 `hjjd/hjmz/hjyc/hjfn/hjsz/hjrq/hjhj` 七类 `栏目/数字.html`，统一为 `https://www.haijiaolove.xyz/...`。
- MissAV：只规范番号并保留实际输入中存在的可信链接；网站只生成浏览器脚本，不直接查询 MissAV。
- 123AV：只规范番号并生成本地任务；只有从外部结果导入的有效详情链接才进入链接输出。

## 4. 自动验证与私人预览

最终回归结果：

```text
cd apps/web-site
npm run lint          # 通过
npx tsc --noEmit      # 通过
npm test              # 通过，78/78；命令内先完成生产构建和 Sites 产物校验
npm run build         # 通过
npm run db:generate   # 通过；No schema changes
cd ../..
git diff --check      # 通过
```

测试覆盖五工具规则夹具、富文本 Telegram 链接与时间戳、跨工具一次入池/独立队列、事务提交与失败回滚、字段级纯文本范围、独立路由和状态恢复、历史、多格式导出、表格键盘选择、处理中心打开任务、123AV 导入预览、MissAV 两层黑名单与三目录，以及所有者权限和 Secret 边界。

Agent Preview 已在运行时提供的约 1366×936 视口完成操作验收：

- Bad.news 输入混合 `/app`、其他域名、带参数主题链接和重复主题链接，只得到一条规范链接；复制当前筛选实际得到 `https://bad.news/t/6295976` 一行。
- 推特的博主名与主页分别输出；MissAV 显示完整脚本文本；123AV 显示本地任务交接和稳定 CSV 字段。
- 工具切换及页面刷新后，已保存 Bad.news 任务与结果仍能恢复。
- 处理中心可打开该任务并显示相同字段级纯文本，再回到 Bad.news 结果页完整恢复该 run。应用页面未产生运行时错误；云浏览器自身扩展有与网站无关的 metadata 日志。
- Telegram 工具输入只显示全局连接复用说明、当前工具绑定来源和严格空状态，不再显示已清理噪声行。
- 工具内 Telegram 工作区实际显示三种独立动作、1～100,000 扫描上限、范围分钟、候选/异常筛选、200 条默认分页和大表格区域；无绑定来源时“仅刷新本地队列”返回 `读取 0 条，本次没有访问 Telegram`。
- 本轮 Bad.news 混合 `/app`、其他域名、带参数主题链接和重复链接，规范结果及剪贴板均严格为 `https://bad.news/t/918273` 一行。

预览运行时未提供可设置为 390×844 的视口接口，因此没有伪报真机截图；响应式断点、移动卡片、选择与导出由源码和自动测试验证，仍需所有者用真实移动端验收。

### 合成性能基准（Node + SQLite D1 模拟器）

```text
100 / 1,000 / 10,000 同来源分组 p95：0.311 / 0.335 / 4.775 ms
1,000 条 Bad.news 纯规则：p50 2.144 ms，p95 4.088 ms
1,000 条一次服务端导入、一个来源绑定五工具：507.988 ms
  D1 模拟请求 110，batch 107，SQL 语句 7,041；消息 1,000，队列 5,000，聚合任务 5
重复导入同一 1,000 条：D1 模拟请求 11，batch 8，SQL 语句 49
1,000 条缓存消息过滤并保存：102.199 ms
  读取与恢复点 29.091 ms；规则 4.308 ms；保存 29.126 ms；状态更新与集合清理 21.953 ms
```

旧前端每 10 条一次请求，1,000 条会产生 100 次完整 HTTP 导入；现为一次上传、服务端受控分块处理。旧提交没有可重复的 D1 调用计数探针，因此不伪造“优化前 SQL 次数或耗时”；当前请求、batch 和语句计数由自动测试直接记录。三条查询计划分别命中 `telegram_tool_queue_tool_status_date_id_idx`、`telegram_messages_source_date_id_idx`、`telegram_tool_queue_message_status_idx`。合成墙钟时间会受共享运行时抖动影响，本轮多次导入落在约 189～508 ms，均低于 2 秒目标；不把该值冒充 Sites D1 p50/p95。

这些是合成数据，不代表 Sites D1 p50/p95。真实 Bot 100 条、个人 API 200 条及 Sites D1 网络/数据库分段耗时仍为待用户 E2E。

## 5. 与 Windows v0.5.13 仍有差异

1. 一次已保存运行的结果页仍会将该运行结果分 500 条页载入浏览器；完整的服务端筛选、排序和“筛选条件 + 排除 ID”选择模型尚未覆盖所有工具结果/任务详情路径。Telegram 队列“全部筛选结果”也仍会在服务端物化最多 100,000 个 ID，而不是短期 selection/job 表。
2. 390×844 真机滚动、手机多选和导出尚未由所有者实机验证。
3. 旧 Telegram 消息中已丢失的富文本 URL 无法凭空恢复，必须回拉原消息后重新入池。
4. Windows 专属的 MissAV/123AV 浏览器执行、Chrome 扩展和账号收藏没有迁移到网页，这是既定产品边界。

## 6. 待用户 E2E 验收

以下项目必须保持“待用户 E2E 验收”，自动测试或构建不能替代：

1. Telegram 个人账号二维码/手机号登录及加密 Session 刷新、重启、重新部署恢复。
2. Bot 真实拉取、全局 offset、Webhook 冲突和重复拉取幂等。
3. 真实来源发现、历史回拉、连续增量和大量群组搜索绑定。
4. 同一来源绑定多个工具后的真实消息独立排队。
5. 真实消息编辑、删除传播及 `never`、`safe_auto`、`manual` 三种已读策略。
6. 断网、限流、Session 失效后的中文错误、重试和恢复。
7. 约 390×844 真机滚动、手机选择、复制和导出。
8. 123AV 外部执行结果 CSV 的真实导入回填，以及 MissAV 生成脚本在所有者浏览器中的真实执行。

## 7. 发布边界

- 本轮新增可回滚的增量迁移 `0005_workflow_contract.sql` 及 Drizzle snapshot：为运行统计/状态、结果错误、任务阶段、Telegram 候选预览和队列消息时间增加字段，并增加三个经查询计划验证的索引；不删除或改写消息、绑定、checkpoint 或正式结果。本轮未部署，故正式 D1 尚未执行迁移。
- 本轮没有保存或部署新的 Sites 生产版本。当前生产保持 Sites v26 / `124e80b491eb4b7a3dee5f3e8eb44aeffc317f9e`。
- 下一步若要上线，应先确保本轮准确源码已进入远端分支，再让新的 Sites 版本对应同一 Git SHA；不能用旧名称 v22 覆盖当前 v26。
- 生产部署必须等待所有者对本轮候选再次明确确认。

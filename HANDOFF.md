# TG 内容工具箱：本地与云端统一主线交接

更新日期：2026-08-23

## 0. 当前统一主线（本轮）

- 当前工作目录：E:\Desktop\codex项目\tg-toolbox-unified
- 当前分支：codex/unified-local-cloud-v1
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

### 本轮最终自动验证

- 网站：TypeScript、ESLint、Vinext 生产构建通过，`90/90` 项测试通过；新增真实网关分块、显式续跑、Pull 后续分页失败、来源复用及消息写入后租约失效回归，构建路由含 `/api/cloud-sync`，产物含 `0006` 迁移。
- 同步 Worker：语法检查、`7/7` 项 Miniflare+D1 测试、Wrangler dry-run 通过；未执行正式部署。
- 仓库总回归：`242/242` 项测试通过，根目录语法检查通过。
- Windows 统一版：Vue/TypeScript/Vite 构建通过；Rust `cargo check` 通过，`33/33` 项测试通过，其中新增失败状态、Push 全量确认和 Pull 游标前进回归。
- `git diff --check` 通过；凭据模式扫描只命中既有安全测试中的明确假 Token 夹具，未发现正式 Secret。

### 尚未完成，不得提前宣称

- 同步网关尚未部署正式 Worker/D1，Sites 尚未配置 `SYNC_GATEWAY_URL`、`SYNC_ADMIN_TOKEN`，因此生产网站和 Windows 目前仍不能真实互通。
- `0006_spicy_omega_sentinel.sql` 尚未在正式 D1 执行，未导入或改写任何正式数据。
- 真实两端首次汇合、断网续传、十万条正式数据与 Telegram 登录/收发 E2E 尚未验收。
- 当前只是源码、模拟 D1、实际 Worker 代码和构建产物通过，不能描述成“已经上线”。
- 云端 Work 当前没有可用的 Cloudflare 管理插件，Wrangler 又被其执行环境网络权限层拦截，因此正式 Worker/D1 创建、备份、迁移和部署仍被基础设施权限阻断；这不是 Windows 源码阻断。

### 下一步交给云端

云端 Work 必须执行 docs/WORK_UNIFIED_CLOUD_PROMPT.md，但不得重复实现已有功能：

1. `fetch` 后以 `codex/unified-local-cloud-v1` 最新远端 HEAD 为唯一源码基线，新建 `codex/cloud/unified-local-cloud-v1-deploy`。
2. 只读审计本轮网站同步、迁移、租约与测试，确认构建源码树和 Git SHA 一致；发现问题先修复并补测试。
   - 必须复核本交接第 10～12 项七个部署阻断已由源码和新增测试真实关闭，不得只复述说明；
   - 本地已复现 Wrangler dry-run、`cargo check` 与 Rust `30/30`，云端环境若不能运行应记为环境限制，不能反推源码未验证。
3. 经所有者明确批准后创建正式同步 Worker/D1、执行网关迁移并设置 Worker 管理 Secret。
4. 在现有私人 Site Secrets 中设置 `SYNC_GATEWAY_URL`、`SYNC_ADMIN_TOKEN`，执行网站 D1 迁移并部署新 Sites 版本。
5. 用空白或脱敏数据完成 Web→Worker→第二设备和第二设备→Worker→Web 往返、冲突、删除、租约 E2E；正式首次汇合仍必须由所有者看过预览后确认。
6. 回写实际 Worker URL（可公开部分）、Git 提交、Sites 部署号、迁移结果与待用户 E2E；不得回写任何 Secret 值。

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
- 未部署前同步 UI 不得指向虚构网关；首次正式数据同步必须由用户在差异预览后确认。
- 云端完成后必须回写真实提交、部署版本、测试结果和待用户 E2E，不能用“构建通过”替代外部验收。

### 当前阻塞点

- 正式部署需要用户批准创建 Cloudflare Worker/D1，并在安全 Secret 存储中设置 SYNC_ADMIN_TOKEN；当前不需要把值发给 Codex。
- Sites 生产环境需要配置 `SYNC_GATEWAY_URL` 与 `SYNC_ADMIN_TOKEN`；值只能进入 Site Secrets。
- 网站接入代码、outbox、Pull、冲突 UI 和 Telegram 跨端租约已经完成；剩余阻塞是正式基础设施部署和真实双端验收。

---

# 历史交接：Web UX v0.5.13 对齐

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

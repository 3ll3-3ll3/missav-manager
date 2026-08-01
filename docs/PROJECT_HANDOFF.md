# TG 内容工具箱 v0.5.13 交接说明

更新日期：2026-07-29
主线分支：`codex/v0.5-redesign`
项目根目录：`E:\Desktop\codex项目\missav-manager`

## 当前结构

```text
apps/desktop-v05/
├─ src/
│  ├─ components/
│  │  ├─ SpreadsheetTable.vue   统一业务表格
│  │  ├─ TaskCenterView.vue      统一处理中心
│  │  ├─ DataCenterView.vue      100k+ 永久数据 CRUD
│  │  ├─ SourcesView.vue         Telegram 个人 API/Bot/文件来源
│  │  ├─ ToolWorkspace.vue       五工具的输入、结果和历史
│  │  ├─ TelegramToolWorkspace.vue 每个工具独立的 TG 历史加载与消息表格
│  │  └─ Av123Account.vue        123AV 账号操作
│  ├─ assets/missav-browser-script.txt
│  ├─ missavScript.ts                番号规范与 CODE_TEXT 注入
│  ├─ missavBlacklistFiles.ts         两层黑名单 TXT 读取、迁移与兼容镜像
│  └─ generated/legacyBundle.js       v0.4.5 已测试过滤规则包
└─ src-tauri/src/
   ├─ missav_blacklists.rs            项目/EXE 同目录 TXT 文件边界
   ├─ workspace.rs                 SQLite、CRUD、备份、迁移、原子 TG 同步
   ├─ telegram_user.rs             grammers、DPAPI 会话、已读标记
   ├─ network.rs                   仅保留 123AV 受限 HTTPS 请求
   ├─ chrome_bridge.rs             Chrome 扩展本机串行桥
   └─ lib.rs                       Tauri 命令边界
```

根目录 Electron v0.4.5 只作稳定旧版、过滤规则和迁移源保留。不得在 v0.5 测试中直接写入 v0.4.5 正式数据库。

## 产品决策

- 五个内容工具彼此独立，首页只提供入口。
- MissAV 只过滤番号并生成完整浏览器脚本。不得恢复 APP 内 MissAV 网络查询、并发、RPS、ETA 或异常重跑。
- MissAV 默认脚本必须保持用户附件脚本为基线，只注入 `CODE_TEXT` 和 `REFERENCE_ACTRESS_TAGS`。参考库默认来自 `Miss_AV.html`（3,680 条书签、1,553 个女优 Tag），支持 HTML 完整替换与逐行编辑。
- 脚本书签导出固定为 `参考女优Tag命中`、`需要查找`、`其他` 三个目录，三个目录始终建立；`需要查找` 的路由优先级最高。
- 两层人物黑名单不得合并。唯一数据源是项目根目录 `missav-blacklists/1-参考女优Tag库黑名单.txt` 与 `missav-blacklists/2-Raindrop导出黑名单.txt`；设置项 `missav.referenceActressTagBlacklist` 和 `missav.raindropExportActressTagBlacklist` 只作旧版迁移与兼容镜像。
- 第一层只在脚本生成时取消参考命中资格，不得从完整参考库物理删除 Tag；删除 TXT 行后必须可恢复。第二层命中后设置 `include_in_import=false`，不得写入 Raindrop HTML/CSV，但必须留在报告与备份中。
- `TG_TOOLBOX_BLACKLIST_DIR` 仅用于隔离测试。常规开发运行定位项目根目录；独立分发的 EXE 使用自身同目录。每次脚本生成必须重新读取 TXT，不能依赖设置页缓存。
- Raindrop 已完全移除。`permanent_records` 中的 Raindrop 兼容字段只为旧库不丢数据，不是活跃产品功能。
- 123AV 保留公开详情查询、Chrome 扩展、APP 内串行助手和 CSV 导出。同一站点的账号操作不并发。
- 日志表保持只读证据性；业务数据表提供增删改查。

## SQLite v506

`workspace.rs` 是 v0.5 业务数据的唯一写入边界，`PRAGMA user_version=506`。除永久记录、运行历史和来源外：

- `telegram_message_fingerprints`：来源 ID + 消息 ID 去重。
- `sync_transactions`：Telegram 原子投递审计。
- `task_inbox`：统一处理中心。
- `script_generations`：只保存模板版本/哈希、任务 ID、番号数和时间，不保存完整脚本。
- `telegram_messages`：来源 ID + 消息 ID 唯一保存一份原始正文。
- `telegram_tool_queue`：同一消息在五个工具中的独立候选、状态、运行 ID 和处理时间。
- `telegram_load_sessions`：每次工具历史加载的模式、扫描数、落库数、前后游标、停止或错误审计。

多工具 Telegram 同步必须通过 `commit_telegram_sync`，在一次 `IMMEDIATE` 事务内写入所有非空任务、永久记录、消息指纹、来源检查点、同步事务和任务收件箱。任一验证或写入失败必须整体回滚。

数据中心的跨页全选通过后端查询全部筛选 ID 完成。批量修改只创建一份操作前备份。单元格编辑、新增、删除和 CSV 导入必须继续保持唯一键、JSON、数值、父来源/父任务校验和操作前备份。

## Telegram

- 个人 API 由 `grammers` 驱动，API 凭据和会话使用 Windows 当前用户 DPAPI 加密文件。
- 设置页中的 Clash HTTP/Mixed Port 对 Telegram 自动解释为 SOCKS5。
- 个人来源默认 `historyLimit=2000`，最高 20000。已读策略是每个来源独立的 `safe_auto | never | manual`；旧数据的 `markRead=true` 兼容映射为 `safe_auto`，其他未声明旧来源按 `never` 处理。
- `safeReadMessageId` 是已安全落库的最高可标位置，`lastMarkedReadMessageId` 是远程标记成功位置，`readBaselineMessageId` 用于排除绑定前或历史回拉消息。三者不得合并或只看来源检查点。
- 历史回拉永不自动标已读。增量迭代必须从检查点之后按旧到新分页，仅用已完整处理的连续范围推进检查点，不得用本页最新消息跳过积压。
- `telegram_user_mark_read` 只接收本地 `source_id`，后端解析远程来源并记录成功/失败。如果 Telegram 已成功但本地状态保存失败，必须明确报告外部副作用已发生。
- Bot 只是 Bot API 增量，不得表述为能回拉完整历史或替个人账号标记已读。Token 仅通过 `telegramBotSession.ts` 保存在本次 WebView 内存；来源页只发现/保存，工具页触发全局 `getUpdates` 并写入所有已绑定工具，不能把同一个 Bot 更新队列伪装成各工具互不影响的远端游标。
- 无定时后台同步。每个工具中的“日常增量同步”和历史加载都是明确手动动作。
- 来源页只负责个人账号/Bot 连接、发现和来源库；具体工具绑定、个人 API 增量同步、历史加载、筛选处理与手动标已读都在该工具的 `TelegramToolWorkspace`。
- 工具历史读取使用 `telegram_user_load_history`，支持 before/after 游标和时间范围；它不得写来源 `checkpoint`、`safeReadMessageId` 或调用 Telegram 已读接口。
- 原始正文经 `telegram_messages` 共享；状态必须写 `telegram_tool_queue` 并以 tool 作为复合主键的一部分，任何工具不得覆盖另一个工具的状态。
- 工具选择处理由 `create_telegram_message_run` 原子写入运行/结果并更新所选队列；空结果不建空任务，但必须标记 `processed_empty`。
- Telegram 消息工作台是每个工具“输入”页内的一种输入模式，不得再拆成顶部一级阶段。所选消息可直接复制原文；文件导出依赖 `dialog:allow-save` 权限。
- 消息工作台必须保留关键词、状态、候选和独立起止时间筛选，以及新增本地消息、时间/正文编辑、当前工具范围删除、可见复选框全选、键盘导航和复制/导出。删除不得影响 Telegram 远端或其他工具队列。
- 手动已读使用 Telegram `channels.ReadHistory` / `messages.ReadHistory` 按来源和 `max_id` 直接提交，不得为了标已读而重新抓取恰好等于检查点的消息。
- 日志不得写入 API hash、手机号、验证码、密码、二维码 URL 或 Bot Token；历史数据显示时也要再脱敏。

## v0.4.5 迁移

`migrate_legacy` 用 SQLite 只读 + `query_only` 打开旧库，完整性通过后先备份 v0.5。`replace=true` 是高影响操作，必须有用户明确确认。

当前数据副本演练基线：

```text
归档旧表：19
归档旧行：112,578
MissAV 永久记录：4,751
123AV 永久记录：4,751
合计永久记录：9,504
历史运行：12
Telegram 来源：12
恢复真实工具绑定：4
旧消息指纹：755
integrity_check：ok
```

v0.4.5 将工具绑定放在 Chromium Local Storage，而非 SQLite。已从只读用户数据副本恢复的真实映射为：福利姬甄选→twitter、bad.news→badnews、海角来源→haijiao、番号待提取→missav，av123 未绑定。其他含义不明的旧来源保留但不擅自绑定。

## 验收

```powershell
cd E:\Desktop\codex项目\missav-manager\apps\desktop-v05
npm run check
npm run test:rust
npm run build:web
npm run tauri -- build

cd E:\Desktop\codex项目\missav-manager
npm test
```

所有数据库测试必须使用临时目录/临时 SQLite，不得运行在正式 AppData 库上。发布前还要执行隔离用户数据首启、Windows UI 冒烟、`git diff --check` 与发布 EXE SHA-256 回填。

当前发布文件为 `dist/TG_Content_Toolbox_v0.5.13.exe`，大小 `19,821,568` 字节，SHA-256 `DBDEB6FF18AE037431F3FCF835D99F448C2DEA815A3FBC8297DFA7858E7B6FB1`。已通过 139 项 Node 测试、24 项 Rust 测试、TypeScript/Vite 与 Tauri Release 构建、来源页和 Bad.news 工具 Telegram 工作台浏览器冒烟，以及隔离 EXE 首启。隔离首启创建 200,704 字节空库并写入 `setup:database_ready`、`setup:ready`；正式数据库未参与测试。

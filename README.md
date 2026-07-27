# TG 内容工具箱 v0.5（Windows）

这是一个只面向 Windows 的本地桌面工具箱。它把 Telegram 消息、官方导出文件或手动文本送入五个彼此独立的工具：推特博主、Bad.news、海角、MissAV 和 123AV。所有业务数据保存在本机 SQLite；不需要服务器账户，也不会上传你的 Telegram 正文、浏览器 Cookie 或密码。

当前主线：`codex/v0.5-redesign`，当前构建版本为 `v0.5.2`。稳定旧版 `v0.4.5` 已由独立 Git tag 保留，v0.5 不会读取、覆盖或删除它的数据库。v0.5.2 已把 v0.4.5 中验证正常的 Telegram 连续授权与网站自适应调度逻辑迁回新界面。

## 发布包

构建完成后使用以下单文件：

```text
apps\desktop-v05\src-tauri\target\release\tg-content-toolbox-v05.exe
```

它不需要 Node.js、Git 或 BAT 脚本。Windows 需要已安装 WebView2 Runtime（Windows 11 通常自带）；首次启动时会创建当前用户独立的数据目录。EXE 未做数字签名，SmartScreen 可能显示“未知发布者”；只应从本仓库的 Release 或已核对 SHA-256 的文件取得。

构建后的准确文件大小、校验值和验收记录见 [发布说明](RELEASE_NOTES.md)。

## 你会看到的结构

```text
工具首页
├─ 推特博主        ─ 输出用户名与 x.com 主页
├─ Bad.news         ─ 输出规范帖子链接
├─ 海角             ─ 输出规范正文链接
├─ MissAV           ─ 番号、标签、永久库与 Raindrop
└─ 123AV            ─ 独立查询、账号收藏与导出

公共入口：数据中心 / Telegram 来源 / 日志 / 设置与备份
```

工具之间不会自动串联：开始 MissAV 不会触发 123AV；不同网站可以同时工作，同一网站由自己的节流和错误保护控制。

## 首次使用

1. 双击 EXE，打开“设置与备份”。
2. 确认数据库位置。默认位置在 Windows 用户数据目录；需要把数据放到项目文件夹时，选择一个专用目录，软件会先创建备份、复制、做 SQLite 完整性检查，重启后才切换。原库保留。
3. 在“设置与备份 → 网络与速度”按站点分别设置代理、并发与 RPS。MissAV 和 123AV 的配置互不影响。
4. 从“工具首页”进入需要的工具。不要在首页先建立批次或配置所有网站。

所有删除、批量改动、迁移和恢复都会先自动备份。数据中心可保存 10 万条以上永久番号，使用服务器端分页与搜索，不会一次性塞进界面。

## Telegram 来源：个人 API、Bot 与文件导出

“Telegram 来源”有三个入口，分别适合不同用途。

| 入口 | 最适合 | 能读取什么 |
| --- | --- | --- |
| 个人账号 API | 自己已加入的群、超级群和频道；历史补读与日常增量 | 已加入的群组、超级群、广播频道 |
| Bot API | 以后新消息的轻量增量 | Bot 被加入后收到的更新 |
| 文件/手动来源 | 大量历史数据 | Telegram Desktop 导出的 HTML/JSON，以及手动文件 |

### 个人账号 API

1. 在 [my.telegram.org/apps](https://my.telegram.org/apps) 获取 `api_id` 和 `api_hash`。
2. 在“个人账号 API”填写它们；优先点“生成二维码”。手机 Telegram 中打开“设置 → 设备 → 连接桌面设备”扫码；也可改用国际格式手机号和验证码，支持两步验证密码。
3. 如果网络需要 Clash，在设置页填写 Clash 的 Mixed Port 或 SOCKS Port，例如 `127.0.0.1:7890`。工具会按 SOCKS5 连接 Telegram。
4. 登录后点击“刷新群组/频道”。页面只显示群组、超级群和频道，不混入私聊。
5. 勾选多个来源，并勾选它们要投递的工具。一个来源可同时投递给多个工具；最多 100 个个人 API 来源。
6. 首次绑定默认“从现在开始”，即记录当前最新消息 ID，以后只读新消息；需要补历史时选择“回拉最近消息”。
7. 点击“同步已绑定个人来源”。每个来源按自己的消息 ID 检查点增量读取，产生独立处理历史。

`api_hash`、登录凭据和二维码不会写进运行日志或普通 SQLite；凭据文件使用当前 Windows 用户的数据保护加密。登录会话只用于本软件。退出个人账号只删本机会话，不会删工具来源、结果或永久库。

### Bot API

1. 用 `@BotFather` 创建 Bot，复制 Token。
2. 通过 `/setprivacy` 为 Bot 关闭 Privacy Mode；已经在群内的 Bot 建议移出再加入，或设为管理员。
3. 将 Bot 加入目标群或频道，发送一条普通识别消息。
4. 在工具箱发现来源、勾选、绑定工具，再手动同步。

如果 Token 曾出现在截图、日志或聊天中，请在 `@BotFather` 输入 `/mybots`，选择对应机器人，再进入 `API Token` 并点 `Revoke current token`；BotFather 会作废旧 Token 并给出新 Token。把新 Token 重新粘贴到工具箱即可，不要把它发给任何人。

Bot 不能补回加入前的历史，且 Telegram 更新不是永久保留的；历史请用官方导出或个人 API。Bot Token 只存在于当前打开的软件内存中，关闭软件后需要重新填写，也不会写入日志。

## 三个文本工具

所有工具都支持直接粘贴，以及一次选择多个 TXT、HTML、HTM、MD、JSON、CSV、LOG 文件；可设置开始/结束时间，精确到分钟。输出框始终是一行一个，结果页可搜索、单击选择、Ctrl/Shift 多选、编辑、批量删除、复制 TSV 或导出 CSV/TXT，并自动保存处理历史。

- 推特博主：以 TG 消息中的 `#标签`、有效 `@handle`、x.com/twitter.com 主页为线索，输出用户名与 `https://x.com/用户名` 两个独立文本框。
- Bad.news：只保留规范 `https://bad.news/t/数字`，自动去除 `/app`、查询参数、片段和无关官网页。
- 海角：只保留经校验的正文路径（`hjjd`、`hjmz`、`hjyc`、`hjfn`、`hjsz`、`hjrq`、`hjhj`），输出规范直达链接并排除广告、栏目首页与垃圾链接。

## MissAV

1. 输入 Telegram 内容、导出文件、链接或番号。过滤后的番号会单独显示，一行一个；可信的 MissAV 详情链接会和番号一起保留。
2. 点击“执行”，再手动启动 MissAV。查询使用优先的真实详情链接和受控候选地址，命中后抓取并清洗女优、类型和最终标签。
3. 查询调度会根据 403、429、超时和真实延迟自动退速并在稳定后逐步恢复。若短时间持续出现 Cloudflare 403 验证页，软件会自动停止尚未发出的请求；更换 Clash 节点后，在结果页不选择记录即可点击“重跑全部异常”。
4. 在“结果”抽查状态。`network_error` 可选中后重跑；`not_found` 与网络异常都会保留可访问/候选链接，方便核对。
5. 每个番号首次被过滤时进入永久库。删除处理历史不会删除永久数据。

## 123AV

123AV 的输入、查询、速度、结果和账号操作完全独立于 MissAV。查询只访问详情页规律及受控变体，不使用慢且误判风险高的搜索页；结果必须从页面可见内容精确核验番号。

账号收藏有三种方式：

- Chrome 扩展：推荐。复用你现有 Chrome 登录状态；首次在 Chrome 扩展页加载 APP 自动释放的文件夹并粘贴配对码。执行固定单路，网络/限频异常会休息 10 秒再自动续跑。
- APP 内串行助手：独立登录窗口；一次只打开一条详情页，由你手动点收藏，再回 APP 记录“已收藏 / 待核验 / 网络问题”。不会读取 Cookie、密码或 Local/Session Storage。
- 仅导出：导出番号与已验证详情链接 CSV，不访问账号。

三种方式都不读取密码、Cookie、完整页面 HTML、Local Storage 或 Session Storage；“已保存”会跳过，状态不明确不会盲目重复点击。

## Raindrop：Pull、Push 与双向同步

Raindrop 位于 MissAV 工具的“Raindrop”页。使用官方 Personal Test Token 或 OAuth Access Token；令牌仅留在当前运行时，不写入数据库或日志。

1. 连接账号并刷新 Collection。
2. 搜索并多选要处理的 Collection。Pull 只读所选范围；Push 的目标可手动选定，或按已知女优自动路由到你选择的 `missav1` / `missav2`。
3. 选择模式：
   - Pull：官网 → 本地，导入可信 MissAV 链接与全部官网 Tags；已知女优/类型会同步为本地关系。
   - Push：本地 → 官网，新建或更新本地管理的 MissAV 记录。
   - 双向：以本地、官网及上次成功快照判断单边改动和冲突。
4. 先生成预览，再点击确认同步。

同步前会扫描本地永久库与 Raindrop 全账号的番号身份：只要两边都有同一番号，就显示“双方已有·不写入”，不因 Collection 位置不同重复创建；“内容一致·不写入”则表示本轮同步字段没有差异。远端 Tag 会在 Pull 时一并写入本地。

官网 CSV 导出仍保留为离线备选；导入 CSV 前应确保链接、标题和 Tags 列没有被表格软件错误拆分或改写。

## 数据中心、日志与备份

- 数据中心：永久番号、标签、处理历史、远端映射与来源的统一 CRUD。支持新增、搜索、分页、逐格编辑、Ctrl/Shift 选择、批量修改、删除、复制 TSV 和 CSV 导出。
- 处理历史：每次工具输入、过滤、网站执行和 Telegram 同步都有独立记录；可搜索、改名、删除。删除前自动备份。
- 日志：集中查看网络、同步和数据库问题。日志会脱敏 Token、手机号、二维码和其他凭据。
- 备份：支持手动创建、查看、恢复和迁移前备份。不要用资源管理器直接替换正在使用的 SQLite 文件。

## 开发与验收

```powershell
cd E:\Desktop\codex项目\missav-manager\apps\desktop-v05
npm install
npm run check
npm run test:rust
npm run build:web
npm run tauri -- build
```

旧版规则与迁移兼容性测试在仓库根目录运行：

```powershell
cd E:\Desktop\codex项目\missav-manager
npm test
```

项目内部实现与迁移说明见 [项目交接说明](docs/PROJECT_HANDOFF.md)。

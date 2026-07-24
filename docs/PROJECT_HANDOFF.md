# TG 内容工具箱项目交接说明

更新时间：2026-07-24

当前本地主线：`0.3.0`

项目目录：`E:\Desktop\codex项目\missav-manager`

本地版本只看当前源码、正式 SQLite 和 `dist` 中实际构建的 EXE，不以 Git 提交、标签或远端 Release 判断。`0.3.0` 在 `0.2.0` 上完成工具注册表、专用入口首页、任务中心、原生 SQLite、10 万条数据库分页与渲染器安全隔离；不包含此前被丢弃的 Codex 接管、任务包或女优关注实验。

## 1. 产品范围

应用负责：

- 以推特博主、Bad.news、MissAV、123AV 四个入口组织功能，各自保存群组绑定、输入和输出；
- 从推特相关消息输出博主名与 x.com 主页；从 Bad.news 消息只输出规范帖子链接；
- 从普通文本、TXT、MD、CSV、Telegram 官方 JSON/HTML、Telegram Bot API 或个人账号 API 中提取并规范番号；
- 使用永久 SQLite 番号库去重；
- 由用户分别启动 MissAV 与 123AV 两条独立查询支线；
- MissAV 命中后抓取、清洗女优与类型标签，并供 Raindrop 同步或文件导出；
- 123AV 命中后生成待收藏任务，可由 Chrome 扩展、APP 内执行器处理，或仅导出 TXT/CSV 清单；
- 管理批次、异常重跑、表格式筛选、多选、复制、导出、日志、体检和备份恢复。

不在当前范围：本地 Favorite/Collection 管理、女优关注、Codex 接管、任务包和自动对外执行方式对比。

## 2. 当前页面与运行顺序

侧边栏只保留全局导航，工具和阶段在工作区内分级：

1. `工具首页`：按文本工具、影片工具分类展示四个入口；侧栏不逐项堆工具。
2. `任务中心`：显示 MissAV、123AV 查询、123AV 收藏、Raindrop、Telegram 的运行状态。
3. 工具工作区：推特/Bad.news 各一个独立页面；MissAV/123AV 进入后再显示输入、执行、结果及可用同步阶段。
4. `Telegram 来源`：Bot、个人账号 API、官方群组导出；最多选择 5 个指定群组，均为手动同步。
5. `数据中心`：永久记录、标签、批次、维护、备份和高级表格编辑。
6. `日志、备份与外观`：公共配置与数据库位置。

数据库仍为每条记录保存四个固定任务槽，但 `tool_kind` 决定有效支线：

- `missavLookup`
- `raindropSync`
- `av123Lookup`
- `av123Favorite`

- MissAV 新批次：`missavLookup` / `raindropSync` 有效，两个 123AV 槽直接 `skipped`；
- 123AV 新批次：`av123Lookup` / `av123Favorite` 有效，两个 MissAV 槽直接 `skipped`；
- 旧 `dual` 批次继续兼容四任务双支线。

## 3. 123AV 收藏方式与站点级队列

`0.1.30` 保留三种明确方式：

- `Chrome 扩展`：本地 Chrome Manifest V3 扩展复用用户现有登录状态；
- `APP 内执行器`：使用 `persist:missav-manager-123av-account` 独立会话与隐藏工作页；
- `仅导出`：生成 TXT/CSV，不访问账号、不点击收藏。

共同约束：

- APP 启动只绑定 `127.0.0.1` 本机端口；
- 使用 256 位随机密钥和 Bearer 认证，密钥经 Windows `safeStorage` 加密；
- 首次由用户在 `chrome://extensions` 手动“加载已解压的扩展程序”并粘贴配对码；
- 扩展只读取可见账号数字、番号、标题和“保存/已保存”状态；
- 禁止读取或输出密码、Cookie、Local Storage、Session Storage、完整 HTML；
- “已保存”直接成功；只有明确看到“保存”才点击，点击后必须再次看到“已保存”；
- Chrome 与 APP 远端收藏均固定 1 路；渲染层和主进程各自兜底，主进程只有一条 123AV 收藏 Promise 队列；
- APP 模式遇到 Error 1015、网络异常或状态不明时整条 123AV 收藏队列休息 10 秒后继续，并在主轮后最多重跑一次；
- 123AV 查询和收藏不重叠；自动收藏只在查询完全结束后启动；
- MissAV 与未来其他网站使用自己的队列，不被 123AV 收藏暂停；
- 登录失效或 CAPTCHA 暂停收藏；
- 重启时遗留的 `running` 收藏必须恢复为 `verify_required`，不能盲目重复点击。

实现文件：

- `src/chromeFavoriteBridge.js`
- `chrome-extension/manifest.json`
- `chrome-extension/service-worker.js`
- `chrome-extension/content-script.js`
- `chrome-extension/popup.html`
- `chrome-extension/popup.js`

## 4. 数据与安全边界

数据库默认位于 Electron `userData/data`，也可由用户迁入项目文件夹中的专用空目录。迁移必须先创建备份、执行 WAL 完整检查点、复制并校验新数据库、保留原文件，然后写入独立位置配置并重启。任何自动测试必须使用临时数据库，禁止接触正式库。

`0.3.0` 使用 Electron/Node 内置 `node:sqlite`，数据库只在主进程核心服务中打开，启用 WAL、外键、忙等待和 FULL 同步。渲染器通过白名单 IPC 调用，不再加载数据库、文件系统或业务 Node 模块。旧 sql.js 文件是标准 SQLite，可首次原生打开；迁移前会自动在 `backups` 生成一次快照和迁移标记。

番号管理使用数据库端搜索、筛选、排序、ID 选择和每页最多 500 条的分页，不再把 5 万条记录一次塞进渲染器。隔离压测已覆盖 100,200 条番号。

长期主数据：

- `codes`：永久番号和去重索引；
- `actresses`、`genres` 及关联表：长期标签数据；
- `processing_runs`、`processing_run_items`、`processing_tasks`：批次、明细和四任务状态；
- `av123_lookup_cache`：123AV 只读查询缓存；
- `raindrop_sync_records`：远端同步映射；
- Telegram 来源、消息指纹、群组绑定与检查点相关表。

`bookmarks` 与 `bookmark_collections` 只用于旧版兼容，不在当前 UI 公开，不得从 `codes` 自动重建，也不得升级时擅自删除。

`0.1.32` 增加用户主动触发的“全库归零”。它与升级迁移不同：只有用户输入确认文字后才执行，先创建完整备份，然后枚举并清空 SQLite 中全部用户业务表（包括未知旧版遗留表），重置自增序号、压缩并做完整性检查。备份目录、外观设置和 Windows 安全存储凭据不属于 SQLite 业务数据，不会被删除。

批次删除只删除指定批次、明细和任务，必须先安全停止并自动备份；永久番号库、标签、导出文件和其他批次不能被连带删除。

## 5. 查询与速度语义

- MissAV 与 123AV 各自保存工作路、自动/固定 RPS、速率上限、学习值和网络错误策略。
- 两站均支持 1、智能、4、6、8、12、16 路档位及 1～32 RPS 上限。
- 123AV 不使用搜索页；访问标准详情地址及受控的已知详情后缀，必须从可见标题或代码字段精确核验番号。
- HTTP 429、连接重置、超时、验证页等归为 `network_error`，可单条、所选或整批重跑。
- 收藏速度与查询速度完全独立；收藏固定单路，查询仍按用户选择的高并发与 RPS 工作。

## 6. Telegram 与 Raindrop

- 历史底库优先使用每个自建群的 Telegram Desktop 官方 JSON/HTML 导出。
- 今后增量优先使用 Bot API；无需 `api_id/api_hash`。个人账号 API 保留为高级补读入口。
- 两种 API 都只允许选择最多 5 个指定群组；同步必须由用户手动发起。
- Bot 只有一个全局更新队列；工具通过持久化的群 `sourceKey` 分别接收。一个群可同时绑定多个工具，消息不会被某个工具“消费掉”。
- 推特与 Bad.news 不建立永久结果表；只保留当前会话结果。Telegram 来源、消息指纹、群绑定和断点继续持久化。
- 四个工具的时间范围精确到分钟；有时间的 Telegram 消息按范围过滤，无时间的手动粘贴文本继续参与。
- Bot Token、个人会话、API 凭据和 Raindrop Token 使用 Windows 安全存储加密。
- 本地只保存消息身份、来源、时间、指纹、提取番号和断点，不保存完整 Telegram 消息正文。
- MissAV 新批次创建时把当前 `actress_tags` 冻结到 `known_actresses_json`。同步时，影片任一女优命中快照进入根 Collection `missav1`；否则进入 `missav2`。缺失目录可自动创建，但必须先逐条预览、再由用户手动同步。旧批次继续使用手动 Collection。

## 7. 验证要求

最低验证：

```powershell
npm run check
npm test
```

当前单元测试基线为 117 项。涉及 UI 时运行隔离 Electron 冒烟：

```powershell
.\node_modules\.bin\electron.cmd .\scripts\ui-smoke.cjs
```

冒烟测试必须使用临时用户目录、临时 SQLite、模拟网络和模拟账号，不得连接正式数据库，不得执行真实收藏。

打包后运行：

```powershell
node .\scripts\verify-package.cjs
```

并检查：

- EXE 文件/产品版本均为 `0.3.0`；
- ASAR 包含工具注册表、原生 SQLite、数据库位置迁移、工具首页、任务中心和完整嵌套视觉资源；
- ASAR 包含 Chrome 桥、APP 内执行器、仅导出入口、单路队列、10 秒恢复和自动第二轮；
- ASAR 不包含 Codex 接管、任务包或女优关注代码；
- 使用独立 `MISSAV_USER_DATA_DIR` 首启，确认窗口、日志、加密桥接密钥和空数据库创建成功。

## 8. 构建

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:portable
```

目标产物：`dist\TG_Content_Toolbox_v0.3.0.exe`。

构建前只关闭能够通过路径、启动时间或唯一测试用户目录确认属于本项目的测试进程；不得结束用户其他 Electron 或 Chrome 进程。构建完成后把实际大小、时间、版本和 SHA-256 写回本文件。

## 9. 当前构建信息

- 路径：`dist\TG_Content_Toolbox_v0.3.0.exe`
- 文件大小：`399,780,545` 字节
- 最后写入：`2026-07-24 12:52:11`
- 文件版本 / 产品版本：`0.3.0` / `0.3.0`
- SHA-256：`94841863BEA9AFB9AADFB6992F92E41EAF014283DB4DAFE169ED6F4EF9530702`

打包后 ASAR 关键标记和禁止标记全部通过；`src/tools` 4 个文件、5 个嵌套视觉资源均已入包，运行包不含 sql.js。使用唯一临时 `MISSAV_USER_DATA_DIR` 对最终便携 EXE 执行无界面隔离首启，退出码为 0，创建 241,664 字节原生 SQLite 空库；日志同时包含 `0.3.0`、`node:sqlite`、`app_window_ready` 和 `app_package_smoke_ready`。临时目录已安全删除，没有残留应用进程。

上一版：

- 路径：`dist\MissAV_Manager_v0.2.0.exe`
- 文件大小：`418,817,176` 字节
- 最后写入：`2026-07-24 11:41:02`
- 文件版本 / 产品版本：`0.2.0` / `0.2.0`
- SHA-256：`0827BFD3D8685CEDC5D945411D95603CB72FF3EA395682B3B635FA45624F2675`

数据库归零和高级编辑自动测试只使用临时 SQLite；只有用户明确要求的正式归零可以写正式数据库，并且必须在所有 MissAV Manager 进程退出后执行。正式归零前后都要只读盘点表行数与 `PRAGMA integrity_check`。

`0.1.32` 正式启用前归零已执行：原库先备份到 `data\backups\missav_data_20260724_001050_正式启用前完整备份.db`，随后 17 张现存用户表全部归零，总行数从 58,764 变为 0，压缩后正式库为 253,952 字节，完整性仍为 `ok`。打包 EXE 另用唯一临时用户目录完成隔离首启，成功写入 `0.1.32` 日志并创建 15 张当前版本业务表、0 行、完整性为 `ok`；测试进程和临时目录均已清理。

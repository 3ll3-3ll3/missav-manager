# Agent Entry Point

本文件适用于整个 `missav-manager` 仓库。开始任何修改前，先完整阅读：

1. `HANDOFF.md` - **当前统一主线、真实基础设施状态、验证结果和下一步；最高优先级。**
2. `docs/UNIFIED_LOCAL_CLOUD_ARCHITECTURE.md` - Windows、Sites 与同步网关的目标架构。
3. `docs/WORK_UNIFIED_CLOUD_PROMPT.md` - 云端 Work 当前实施边界。
4. `docs/PROJECT_HANDOFF.md`、`docs/CHATGPT_WORK_SITE_HANDOFF.md` 与旧 Changelog - 只作为历史产品语义和追溯材料，不能覆盖上述当前主线。
5. `README.md` 与 `使用教程.md` - 用户视角的功能和操作说明。

## 2026-08-24 统一主线覆盖（最高优先级）

- 当前开发主线是 `codex/unified-local-cloud-v1`，不是 `codex/cloud/web-ux-parity-v0513`。
- `codex/cloud/web-ux-parity-v0513` 是统一主线的起始网站基线；PR #4、`0005` 和 Sites v26 记录属于前序阶段。
- 当前统一主线已新增 `packages/sync-contract`、`apps/sync-service`、网站 `0006_spicy_omega_sentinel.sql` 和 Windows v0.6.0 同步中心。
- 正式同步 Worker 与独立 D1 已部署；生产 Site 仍是 v26，正式 Site D1 尚未执行 `0006`，因此网站和 Windows 仍未正式业务互通。
- `HANDOFF.md` 中“历史交接”标题之后的内容只用于追溯，不得据此重新判定当前分支、当前迁移或下一步。
- 任何 Work 若未检查 `origin/codex/unified-local-cloud-v1`，不得宣称已经完成当前主线核对。

## 接手约束

- 当前工作区未提交，并可能包含用户在本轮之前留下的修改。不要执行 `git reset --hard`、`git checkout --` 或整文件回退。
- 长期主数据是用户目录中的 SQLite 数据库，不在仓库内。测试必须使用临时数据库，禁止把示例 CSV/HTML 导入用户真实数据库。
- `codes` 是当前永久番号主表和去重索引，女优/类型 Tag 关系是当前长期主数据。
- `bookmarks` 与 `bookmark_collections` 仅为旧版兼容表：不得自动从 `codes` 重建，不在当前 UI 中公开，也不得在升级时擅自删除。
- Raindrop HTML / CSV 仅作为“本次处理结果”的下游导出；不要重新引入本地 Favorite、Collection 或收藏管理入口，除非用户明确改变产品方向。
- 管理页选择语义应保持与 Windows 文件管理器一致：单击替换、Ctrl 切换、Shift 连选、Ctrl+Shift 追加区间。
- 当前版本以本地 `dist` 目录中实际生成的最新便携版 EXE 为唯一依据，不使用 GitHub Release、Git 标签或提交记录判定最新版。
- 当前本地主线版本为 `0.4.0`；处理页的番号文件入口必须支持一次多选 TXT/HTML/HTM/MD/JSON/CSV/LOG，成功文件按返回顺序合并过滤，单文件失败不能丢弃其他成功内容；输入中的可信 MissAV 详情链接必须随番号永久保存并优先查询。首次见到的番号立即进入永久库，批次只作为来源与历史，不得成为 Raindrop 等后续操作的数据主键。创建批次后不自动联网，MissAV 与 123AV 必须由用户分别开始/继续/停止，两站速度档位独立保存。123AV 番号查询与账号收藏完全分层；收藏仅保留 Chrome 扩展、APP 内执行器、仅导出三种方式，远端收藏固定单路，自动收藏只能在 123AV 查询结束后启动；不同网站可使用各自队列同时工作。扩展不得读取或输出密码、Cookie、Local/Session Storage 或完整页面 HTML；登录/CAPTCHA/点击不明必须停止副作用并进入明确异常或 `verify_required`，APP 模式的普通网络异常/Error 1015 休息 10 秒后再续跑。不得重新加入 Codex 接管、任务包或女优关注实验。批次删除必须先停止在途任务、自动备份并只删除批次/明细/任务，不连带删除永久番号库或导出文件。Raindrop 必须由永久库的全局队列驱动，默认按已冻结目标进入根目录 missav1/missav2，目录丢失时自动恢复；手动 Collection 作用于整个当前范围，并同时保留 API 同步和官网兼容 CSV 导出。Telegram 历史以群组或频道官方导出建立底库；Bot API 是无需 `api_id/api_hash` 的默认增量入口，个人账号 API 保留为可补读历史的高级入口；两者最多选择 100 个指定群组或频道，均只手动同步。个人 API 可选在完整同步成功落库后标记已读，默认关闭，Bot 不得实现该副作用。每个工具可同时绑定多个群组或频道并独立保存，旧版单来源绑定自动迁移；来源绑定 UI 必须支持搜索和普通单击勾选，不得要求 Ctrl/Shift。推特过滤以每条消息的 ASCII `#标签` 为主，保留有效 `@用户名` 和 X/Twitter 主页兜底，排除短主题标签、传送门标签与推广机器人。海角过滤只接收 `hjjd/hjmz/hjyc/hjfn/hjsz/hjrq/hjhj` 七类数字 `.html` 正文路径，统一到 `www.haijiaolove.xyz` 并排除广告、旧域名和栏目页。三个文本工具可手动保存规范结果快照到各自历史，但不得保存原始 TG 正文；MissAV/123AV 历史必须复用处理批次。五个工具均可从统一历史页回看、恢复/载入、搜索、导出、重命名和删除。Bot Token、个人会话和 API 凭据使用 Windows 安全存储加密。新安装默认护眼淡绿主题且无背景图，但不得覆盖用户已经保存的外观选择。
- `0.3.0` 的产品外壳是“TG 内容工具箱”：侧栏只放工具首页、任务中心和全局设置，推特博主、Bad.news、海角帖子、MissAV、123AV 由注册表驱动的专用首页进入，工具自己的阶段放在工作区二级导航。三个文本过滤工具的当前结果留在会话中，并可由用户明确保存为历史快照；Telegram 来源、消息指纹和断点持久化。数据库在主进程使用原生 SQLite/WAL，渲染器不得直接访问数据库或任意文件路径；番号管理必须使用数据库端分页以支持 10 万条以上。数据库位置可由用户迁入自选空目录，但必须先备份、完整复制与校验，且保留原数据库。

## 每次修改后的最低验证

```powershell
npm run check
npm test
git diff --check
```

涉及 UI 时还需要启动 Electron 做桌面截图验收；涉及导入导出时使用 `docs/PROJECT_HANDOFF.md` 中的官方备份夹具做隔离往返测试。

## Windows 构建

网络受限时使用国内镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:portable
```

构建前关闭确认属于本项目的 `TG_Content_Toolbox` 或旧 `MissAV_Manager` 测试进程，否则便携 EXE 可能被锁定。

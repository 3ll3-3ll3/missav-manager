# Agent Entry Point

本文件适用于整个 `missav-manager` 仓库。开始任何修改前，先完整阅读：

1. `docs/PROJECT_HANDOFF.md` - 当前版本、架构、数据语义、验证方式和下一步。
2. `docs/CHANGELOG_2026-07-12.md` - 本轮修改日志与行为变化。
3. `README.md` 与 `使用教程.md` - 用户视角的功能和操作说明。

## 接手约束

- 当前工作区未提交，并可能包含用户在本轮之前留下的修改。不要执行 `git reset --hard`、`git checkout --` 或整文件回退。
- 长期主数据是用户目录中的 SQLite 数据库，不在仓库内。测试必须使用临时数据库，禁止把示例 CSV/HTML 导入用户真实数据库。
- `codes` 是当前永久番号主表和去重索引，女优/类型 Tag 关系是当前长期主数据。
- `bookmarks` 与 `bookmark_collections` 仅为旧版兼容表：不得自动从 `codes` 重建，不在当前 UI 中公开，也不得在升级时擅自删除。
- Raindrop HTML / CSV 仅作为“本次处理结果”的下游导出；不要重新引入本地 Favorite、Collection 或收藏管理入口，除非用户明确改变产品方向。
- 管理页选择语义应保持与 Windows 文件管理器一致：单击替换、Ctrl 切换、Shift 连选、Ctrl+Shift 追加区间。
- 当前版本以本地 `dist` 目录中实际生成的最新便携版 EXE 为唯一依据，不使用 GitHub Release、Git 标签或提交记录判定最新版。
- 当前本地主线版本为 `0.3.0`；处理页的番号文件入口必须支持一次多选 TXT/HTML/HTM/MD/JSON/CSV/LOG，成功文件按返回顺序合并过滤，单文件失败不能丢弃其他成功内容。创建批次后不自动联网，MissAV 与 123AV 必须由用户分别开始/继续/停止，两站速度档位独立保存。123AV 番号查询与账号收藏完全分层；收藏仅保留 Chrome 扩展、APP 内执行器、仅导出三种方式，远端收藏固定单路，自动收藏只能在 123AV 查询结束后启动；不同网站可使用各自队列同时工作。扩展不得读取或输出密码、Cookie、Local/Session Storage 或完整页面 HTML；登录/CAPTCHA/点击不明必须停止副作用并进入明确异常或 `verify_required`，APP 模式的普通网络异常/Error 1015 休息 10 秒后再续跑。不得重新加入 Codex 接管、任务包或女优关注实验。批次删除必须先停止在途任务、自动备份并只删除批次/明细/任务，不连带删除永久番号库或导出文件。Telegram 历史以群组官方导出建立底库；Bot API 是无需 `api_id/api_hash` 的默认增量入口，个人账号 API 保留为可补读历史的高级入口；两者最多选择 5 个指定群组，均只手动同步。Bot Token、个人会话和 API 凭据使用 Windows 安全存储加密。新安装默认护眼淡绿主题且无背景图，但不得覆盖用户已经保存的外观选择。
- `0.3.0` 的产品外壳是“TG 内容工具箱”：侧栏只放工具首页、任务中心和全局设置，推特博主、Bad.news、MissAV、123AV 由注册表驱动的专用首页进入，工具自己的阶段放在工作区二级导航。推特/Bad.news 结果只保留当前会话；Telegram 来源、消息指纹和断点持久化。数据库在主进程使用原生 SQLite/WAL，渲染器不得直接访问数据库或任意文件路径；番号管理必须使用数据库端分页以支持 10 万条以上。数据库位置可由用户迁入自选空目录，但必须先备份、完整复制与校验，且保留原数据库。

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

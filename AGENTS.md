# Agent Entry Point

本文件适用于整个 `missav-manager` 仓库。开始任何修改前，先完整阅读：

1. `docs/PROJECT_HANDOFF.md` - 当前版本、架构、数据语义、验证方式和下一步。
2. `docs/CHANGELOG_2026-07-12.md` - 本轮修改日志与行为变化。
3. `README.md` 与 `使用教程.md` - 用户视角的功能和操作说明。

## 接手约束

- 当前工作区未提交，并可能包含用户在本轮之前留下的修改。不要执行 `git reset --hard`、`git checkout --` 或整文件回退。
- 长期主数据是用户目录中的 SQLite 数据库，不在仓库内。测试必须使用临时数据库，禁止把示例 CSV/HTML 导入用户真实数据库。
- `bookmarks` 是完整收藏主表；`codes` 是永久番号历史/去重索引。删除收藏或 Collection 不应连带删除 `codes`。
- Raindrop 官方 CSV 是无损主格式；HTML 是层级、Last Modified、Notes、Highlights 等字段的补充格式。
- 同一 URL 可以有多条合法收藏。优先按 Raindrop ID 匹配；无 ID 的 HTML 记录按 URL + Title + Collection 精确匹配。
- Collection 标准路径分隔符是 ` / `。`bookmark_collections` 保存空文件夹和目录层级。
- 保持 `package.json` 当前版本 `0.1.0`，除非用户明确要求发布新版本。

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

构建前关闭所有 `MissAV_Manager` 测试进程，否则 `dist\MissAV_Manager_v0.1.0.exe` 可能被锁定。

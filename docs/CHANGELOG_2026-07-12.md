# 2026-07-12 修改日志

本日志记录本轮围绕 Electron 启动、历史番号数据库、Raindrop 官方格式兼容、收藏编辑和 Collection 层级管理完成的修改。

## 1. Electron 启动与构建

- 将 Electron 升级并锁定到当前 `package.json` / `package-lock.json` 配置，当前构建使用 Electron 43.1.0。
- 修订 `启动MissAV.bat` 和 `启动MissAV.vbs`：缺少 Electron 运行文件时使用国内镜像修复安装。
- 构建时支持：
  - `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
  - `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- 解决最初的 `TypeError: fetch failed` / `Electron failed to install correctly` 启动问题。
- 重新生成 `dist\MissAV_Manager_v0.1.0.exe`。

## 2. Raindrop 官方格式适配

新增 `src/raindrop.js`，实现：

- 解析官方 11 列 CSV。
- 生成官方 11 列 CSV。
- 解析 Netscape Bookmark HTML 中的嵌套 H3/DL Collection。
- 读取 HREF、ADD_DATE、LAST_MODIFIED、TAGS、DATA-COVER、DATA-IMPORTANT。
- 读取 `<DD>` Note 和 `<blockquote>` Highlights。
- 生成带层级 Collection、Note、Highlights、Favorite 的 HTML。

格式结论：

- CSV 是无损主备份，因为它包含 Raindrop ID 和 Excerpt。
- HTML 不含稳定 Raindrop ID 和 Excerpt，但可补充层级、Last Modified、Notes 和 Highlights。
- 同时选择 CSV/HTML 时会合并互补字段。

## 3. 官方 CSV 多行异常修复

修改 `src/csvTools.js`：

- 检测完整官方 11 列表头。
- 修复未加引号的多行 Excerpt。
- 按数字 Raindrop ID 识别下一条记录边界。
- 保留原始多行内容，并把 URL、Folder、Tags、Created 等尾部字段恢复到正确列。
- 普通 CSV 继续使用原有通用解析行为。

修复前示例文件被显示为 4,544 行并出现 1 条错误 URL 提醒；修复后为 4,532 条有效记录、0 个校验问题。

## 4. 收藏主数据库

修改 `src/database.js`，新增通用 `bookmarks` 表：

- 保存 Raindrop ID、Title、Note、Excerpt、URL、Folder、Tags、Created、Cover、Highlights、Favorite、Last Modified。
- 保存可选番号 `code` 和 `source_code_id`。
- 旧 `codes` 记录自动迁移为收藏记录。
- 数据库首次迁移前自动备份。
- 允许多条收藏关联同一个番号索引。
- 允许相同 URL 以不同 Title/Collection 作为独立收藏存在。

新增 API：

- `getBookmarkLibrary`
- `getBookmarkStats`
- `importRaindropRecords`
- `exportRaindropRecords`
- `createBookmarkRecord`
- `updateBookmarkRecord`
- `deleteBookmarkRecord`

关键删除规则：删除收藏不删除 `codes`，确保历史去重能力不会因用户整理收藏而丢失。

## 5. Collection 独立目录模型

新增 `bookmark_collections` 表和对应迁移：

- 从现有收藏 Folder 自动建立全部父目录。
- 支持没有收藏的空目录。
- 统一 `父级 / 子级` 路径格式。
- 新建目录时自动补齐父目录。
- 重命名目录时同步迁移全部后代目录和收藏。
- 删除目录时删除目录子树内收藏，但保留永久番号索引。

新增 API：

- `getBookmarkCollections`
- `getBookmarkCollectionInfo`
- `createBookmarkCollection`
- `renameBookmarkCollection`
- `deleteBookmarkCollection`

## 6. 收藏库 UI 重构

修改 `renderer/app.js`、`renderer/index.html` 和 `renderer/styles.css`：

- 收藏库改为 Collection 树、记录列表、详情编辑器三栏布局。
- 左侧 Collection 从平铺字符串改为父子树。
- 支持展开/折叠、创建顶级文件夹、创建子文件夹、重命名和删除。
- 父文件夹数量显示其整个子树收藏总数。
- 点击父文件夹筛选父级及全部子级记录。
- “新增番号”改为更准确的“新建收藏”。
- “选择本页”改为“选择当前范围”，可跨分页选择当前搜索/筛选/目录子树的全部记录。
- 删除目录前显示子目录数和收藏数，并自动创建备份。
- Favorite 可在列表直接切换。
- 记录可单条删除或批量删除，番号历史继续保留。

详情编辑器现支持：

- Title
- Link
- Collection
- Tags
- Note
- Created
- Excerpt
- Highlights
- Cover
- Favorite
- Raindrop ID
- Last Modified
- 番号索引和旧女优/类型 Tag

## 7. CSV 工作台

- 自动识别官方 Raindrop CSV。
- 主表仅显示高频字段，减少视觉噪声。
- 右侧详情编辑全部 11 个字段。
- 修复详情输入时每字符重绘造成的焦点丢失。
- 表格与详情双向同步。
- Favorite 筛选只读取官方 `favorite` 列。
- 保存时保持隐藏字段和官方列顺序。
- 可直接将当前官方 CSV 导入本地收藏库。

## 8. 导入、导出和去重

- 顶部导入入口可一次选择多个官方 CSV/HTML 文件。
- 导入前自动创建数据库备份。
- 带 ID 记录按 ID 合并。
- 无 ID HTML 优先按 URL + Title + Collection 精确匹配。
- 避免把相同 URL、不同 Collection 的合法重复收藏合并。
- 新收藏中识别出的番号自动写入永久 `codes` 索引。
- 本地收藏库可直接导出官方 CSV 或 HTML。
- 导入比较继续使用整个历史番号索引，不受收藏删除影响。

## 9. 文档

更新：

- `README.md`
- `使用教程.md`

新增：

- `AGENTS.md`
- `docs/PROJECT_HANDOFF.md`
- `docs/CHANGELOG_2026-07-12.md`

## 10. 自动测试和真实夹具验证

新增 `test/`，当前共有 14 项自动测试，已全部通过。

覆盖：

- CSV 引号、重复表头和异常多行修复。
- Parser 标准番号和 FC2。
- Fetcher 状态分类、重定向和网络错误。
- Raindrop CSV/HTML 往返。
- 数据库备份恢复。
- 官方 ID 合并。
- 相同 URL 不同 Collection 保留。
- 收藏与番号索引解除。
- Collection 空目录、新建、父目录重命名和删除。

最终最低验证结果：

```text
npm run check   PASS
npm test        14/14 PASS
git diff --check PASS（仅 CRLF 提醒）
npm run build:portable PASS
```

## 11. 尚未完成或建议继续

- 对最新版 Collection 树补做真实 4,582 条收藏的 Windows 截图验收；上次应用控制授权超时。
- 加入拖放移动收藏和目录。
- 加入 Shift 连选、Ctrl 多选和列表全选复选框。
- 用目录选择器替代批量移动时的纯文本输入。
- 设计空 Collection 的 HTML 导出方案。
- 增加最近一次批量操作的撤销入口。
- 在发布新版本前审查 `package-lock.json` 大范围差异，并决定是否提升版本号。

## 12. Collection 交互修复（21:51 构建）

- 定位“新建文件夹无效”的根因：Electron 不支持浏览器 `window.prompt()`。
- Collection 新建和重命名改用应用内模态输入框，支持 Enter 提交、Escape/点击遮罩取消。
- 普通文件夹支持右键菜单和常显 `⋮` 菜单：打开、选择当前范围、新建子文件夹、重命名、删除。
- “全部收藏”右键菜单新增“清空全部收藏和文件夹”。
- “未分类”右键菜单新增“清空未分类收藏”。
- “全部收藏”和“未分类”明确作为系统视图保留，不伪装成普通可删除文件夹。
- 展开/折叠控件从不明显的 `›/⌄` 改为高对比度 `▸/▾`。
- 右键菜单移到窗口根层，修复菜单相对鼠标位置偏移。
- 新增范围删除数据库 API；清空全部时删除收藏和实际 Collection，但保留 `codes` 永久番号索引。
- 修复初始化/恢复流程：已有 `bookmarks` 表时不再重复执行旧番号迁移，防止用户清空收藏后重启又被 `codes` 自动重建。
- 自动测试覆盖“清空未分类”“清空全部”“重启不重建收藏”，14/14 通过。
- Windows 可视化验收确认新建弹窗和右键菜单正常；未执行任何破坏性确认。

数据安全记录：当前真实库为 0 收藏，但自动备份 `missav_data_20260712_212520_delete_collection.db` 仍包含完整 4582 条收藏。未擅自恢复。

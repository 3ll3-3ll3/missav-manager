# MissAV Manager 项目交接说明

最后更新：2026-07-12  
当前应用版本：`0.1.0`  
项目目录：`E:\Desktop\codex项目\missav-manager`

## 1. 当前产品定位

MissAV Manager 已从单纯的“番号抓取和 Raindrop 导入文件生成器”，扩展成一个本地优先的 Raindrop 兼容收藏数据库：

- 保存用户过去收集过的全部番号，作为永久去重历史。
- 保存普通网页和番号收藏的完整 Raindrop 字段。
- 新内容导入前与全部历史番号比较，可选择跳过已有内容。
- 在 App 内像 Raindrop 一样浏览 Collection、筛选记录并直接编辑详情。
- 支持 Raindrop 官方 CSV/HTML 的双向导入导出。
- CSV 工作台可直接编辑官方备份，同时隐藏不常用列但不丢失数据。

用户当前最重视两件事：

1. 历史番号数据库必须足够大、稳定，导入新内容时可据此排除旧内容。
2. 收藏数据必须可直接编辑，交互尽量接近 Raindrop，而不是只能生成一次性导入文件。

## 2. 当前数据架构

### 2.1 主表职责

| 表 | 职责 |
| --- | --- |
| `bookmarks` | 收藏主表，保存 Raindrop 字段和可选番号关联 |
| `bookmark_collections` | Collection 目录表，保存空文件夹及父子层级 |
| `codes` | 永久番号历史和去重索引 |
| `actress_tags` / `actress_code_map` | 女优 Tag 及番号关系 |
| `genre_tags` / `code_genres` | 类型 Tag 及番号关系 |
| `processing_runs` | 处理批次统计 |

`bookmarks.source_code_id` 可关联到 `codes.id`。一条番号索引可以被多条收藏引用，同一 URL 也允许出现在不同 Collection 中。

### 2.2 收藏字段

Raindrop 官方 CSV 的标准顺序是：

```text
id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite
```

本地 `bookmarks` 还额外保存：

- `last_modified`：来自 HTML。
- `code`：可选的标准番号。
- `source_code_id`：到永久番号索引的关联。
- `created_at` / `updated_at`：本地维护时间。

### 2.3 不可破坏的数据语义

- 删除一条收藏：删除 `bookmarks` 行，但不删除对应 `codes` 行。
- 删除一个 Collection：删除该目录和子目录里的收藏，但不删除番号历史。
- 清空收藏的番号字段：解除收藏与 `codes` 的关联，历史番号仍保留。
- 导入带 Raindrop ID 的记录：首先按 ID 更新。
- 导入无 ID 的 HTML：按 URL + Title + Collection 精确匹配，避免把相同 URL 的不同收藏错误合并。
- CSV 与 HTML 同时导入：CSV 提供 ID/Excerpt 等无损字段，HTML补充层级、Notes、Highlights 和 Last Modified；空字段不覆盖已有非空字段。

## 3. Collection 目录模型

Collection 路径统一规范为：

```text
父文件夹 / 子文件夹 / 三级文件夹
```

目录行为：

- `bookmark_collections` 会自动保存每一级父目录。
- 空文件夹可以独立存在，即使里面没有收藏。
- App 启动迁移时会从现有 `bookmarks.folder` 自动建立目录表。
- 重命名父目录会同步改写所有后代目录和收藏路径。
- 点击父目录会筛选父目录本身及全部子目录记录。
- “选择当前范围”会选中当前搜索、状态筛选和目录子树下的全部记录，不受 160 条分页限制。
- 删除目录前 UI 会显示子目录数和收藏数，并自动创建数据库备份。

注意：Raindrop CSV 没有独立的 Collection 记录，因此纯空文件夹无法通过 CSV 表达。当前 HTML 生成器也是从收藏构建目录树，空文件夹暂时不会出现在导出文件中。这是后续可完善项。

## 4. 导入导出实现

### 4.1 核心文件

- `src/raindrop.js`：官方 CSV/HTML 解析和生成。
- `src/csvTools.js`：通用 CSV 解析、校验、保存，以及官方异常多行修复。
- `src/database.js`：收藏、目录、番号索引、备份和迁移。
- `preload.js`：向 Renderer 暴露安全 API。
- `renderer/app.js`：导入流程、收藏库、Collection 树、详情编辑和 CSV 工作台。

### 4.2 官方 CSV 异常兼容

用户提供的官方 CSV 中有一条 Excerpt 包含未加引号的多行文本。普通 RFC CSV 解析会把该收藏拆成 13 行，并导致 URL/Collection 字段错位。

`src/csvTools.js` 的 `repairRaindropLineBreaks()` 只在检测到完整官方 11 列表头时启用，按数字 Raindrop ID 边界重组记录，并保留 Excerpt 换行。普通 CSV 不受此规则影响。

## 5. UI 当前状态

### 5.1 收藏库

当前是三栏工作区：

1. 左侧：真正的 Collection 树，支持展开/折叠、新建子目录、重命名和删除。
2. 中间：收藏列表，支持分页、单选、多选、Favorite、打开链接。
3. 右侧：直接编辑 Title、Link、Collection、Tags、Note、Created、Excerpt、Highlights、Cover、Favorite、Raindrop ID、Last Modified 和可选番号索引。

顶部支持搜索、筛选、排序、选择当前范围、批量删除、批量移动 Collection、批量 Tags 和导出官方 CSV/HTML。

### 5.2 CSV 工作台

打开官方 CSV 后：

- 表格只显示 Title、URL、Folder、Tags、Created、Favorite 等高频列。
- 右侧显示全部 11 个官方字段。
- 隐藏列在保存时完整保留。
- 详情编辑不会每个字符重绘，已修复焦点丢失。
- 点击任意单元格会同步右侧详情。
- Favorite 筛选严格读取 `favorite` 列。

## 6. 启动和构建

### 6.1 开发运行

```powershell
npm install
npm start
```

源码目录的 `启动MissAV.bat` / `启动MissAV.vbs` 已加入国内 Electron 镜像修复逻辑，用于处理 `fetch failed` 和 Electron 安装不完整。

### 6.2 便携版

最新构建：

```text
E:\Desktop\codex项目\missav-manager\dist\MissAV_Manager_v0.1.0.exe
```

最近一次已确认文件信息：

- 构建时间：2026-07-12 23:57:13
- 大小：91,176,874 字节
- Electron：43.1.0
- Node.js 要求：22.12 或更高

便携版内含 Electron，用户启动时不应再在线下载 Electron。

## 7. 测试夹具与验证结果

用户提供的官方备份文件：

```text
C:\Users\WJL\Downloads\a1f9a8ad-4477-4132-9194-cdfbe10a8d89.csv
C:\Users\WJL\Downloads\a1f9a8ad-4477-4132-9194-cdfbe10a8d89.html
```

这些文件只能在临时数据库中测试，不能导入用户真实数据库。

已验证结果：

- CSV：4,532 条有效收藏。
- HTML：4,532 条收藏。
- CSV 导入临时库：4,532 条。
- HTML 合并：更新 4,532 条，新增 0 条。
- 合并后数据库：4,532 条。
- 识别并同步到永久番号索引：3,177 条。
- 再导出 CSV 并解析：4,532 条。
- 再导出 HTML 并解析：4,532 条。

自动测试命令：

```powershell
npm run check
npm test
git diff --check
```

当前自动测试为 14 项，覆盖 CSV、数据库备份恢复、Raindrop 往返、重复 URL 收藏、番号索引解除、Collection 新建/重命名/删除、Fetcher 与 Parser。

## 8. 工作区状态

当前修改尚未提交。`git status` 中包含大量已修改文件和新增的 `src/raindrop.js`、`test/`。不要假设所有差异都由单一 agent 产生，也不要整批回退。

尤其注意：

- `package-lock.json` 差异较大，提交前应单独审查其依赖和换行变化。
- `dist/` 是构建输出，不应作为源码修改依据。
- 用户真实数据库位于 Electron `userData` 目录，可在 App 的“外观 -> 数据位置”查看。
- 数据库迁移前会生成备份；大批量编辑和删除 Collection 也会创建备份。

2026-07-12 21:27 左右，用户连续测试了 Collection 删除和批量删除。当前真实主库状态是 `0 bookmarks / 2927 codes / 44 collections`。这不是读取错误；完整收藏仍可从以下自动备份恢复：

```text
C:\Users\WJL\AppData\Roaming\missav-manager\data\backups\missav_data_20260712_212520_delete_collection.db
```

该备份经只读检查包含 `4582 bookmarks / 2927 codes / 196 collections`。不要由 agent 擅自恢复，必须由用户明确选择恢复。后续各删除阶段也有 21:25-21:27 的连续备份。

## 9. 下一位 agent 的建议起点

1. 先运行三项最低验证，确认工作区没有被后续操作破坏。
2. 如果用户明确恢复 4582 条备份，再检查 Collection 树在真实收藏上的深层目录表现。
3. 检查深层目录的缩进、操作按钮 hover、窄窗口响应和超长名称。
4. 使用临时数据库测试目录新建、重命名、删除和“选择当前范围”，不要在真实库执行破坏性验收。
5. 后续最有价值的 Raindrop 接近项：拖放移动收藏/文件夹、Shift 范围选择、右键菜单、批量移动的目录选择器、导出空文件夹、撤销最近操作。

Windows 可视化验收已确认：应用内新建 Collection 弹窗正常；“全部收藏”右键菜单在鼠标位置显示；常显 `⋮` 和 `▸/▾` 控件正常。验收未提交新建、删除或恢复操作。数据库测试、语法检查和便携版构建均已通过。

# MissAV Manager v2.16

MissAV Manager 是一个本地桌面 App，用于从文本、Telegram HTML、TXT、MD、CSV 等内容中提取番号，生成/核验 MissAV 链接，维护 SQLite 本地库，并导出 Raindrop.io 可导入的 HTML / CSV 文件。

完整教程见：[使用教程.md](使用教程.md)。

## 给 Windows 用户

推荐从 [Releases](https://github.com/3ll3-3ll3/missav-manager/releases/latest) 下载 `MissAV_Manager_v*.exe`：

1. 下载单个 EXE 文件到任意可写文件夹。
2. 双击 EXE 启动，无需安装 Node.js、Git 或其他运行环境。
3. 首次运行会自动创建自己的本地数据库；升级 EXE 不会覆盖已有数据。

这是未签名的个人桌面软件，Windows SmartScreen 可能会显示提示。只应从本仓库的 Releases 下载。

应用会把数据库和备份保存到 Windows 的用户数据目录，而不是 EXE 所在目录。你可以在 App 的“外观 -> 数据位置”查看实际路径，并通过“备份恢复”创建或恢复备份。

处理页面时需要网络能够访问目标页面；程序不要求登录账号，也不会随安装包附带任何收藏数据。

## 给开发者

需要 Node.js 18 或更高版本：

```bash
npm install
npm start
```

开发模式：

```bash
npm run dev
```

也可以双击源码目录中的 `启动MissAV.bat`；它会在本机缺少依赖时执行 `npm install`。

## 核心功能

| 模块 | 说明 |
| --- | --- |
| 番号处理 | 粘贴任意文本、Telegram HTML、Markdown、MissAV 链接或番号，自动提取并标准化 |
| 运行控制 | 生成候选链接，访问 MissAV，抓取女优 tag / 类型 tag，写入本地库 |
| 处理结果 | 查看本次处理结果，导出本次 HTML / CSV / 报告 |
| SQLite 本地库 | 管理番号、链接、状态、女优 tag、类型 tag、Raindrop 字段 |
| 整理卡片 | 单条聚焦整理，可快速修复链接、状态、Title、Collection、Tags、Note、Created |
| 导出预览 | 导出前检查可导出记录、无链接记录、状态矛盾和缺失字段 |
| CSV 工作台 | 打开、编辑、校验、备份、另存 CSV，并可导入本地库 |
| 数据体检 | 检查无链接、缺 tag、孤立 tag、坏关联、疑似重复和状态矛盾 |
| 备份恢复 | 创建/恢复 SQLite 数据库备份 |
| 外观设置 | 护眼淡绿等多主题，自定义背景图，界面密度设置 |

## 推荐流程

```text
导入/粘贴原始文本 -> 提取番号 -> 开始处理 -> 查看结果 -> 本地库整理 -> 整理卡片/导出预览 -> 导出 Raindrop CSV 或 HTML
```

## 输出文件

导出时会创建 `YYYYMMDD_HHMM_missav_import/` 文件夹，常见文件包括：

| 文件 | 用途 |
| --- | --- |
| `*_missav_raindrop_import.html` | Raindrop 导入 HTML |
| `*_missav_raindrop_import.csv` | Raindrop 导入 CSV |
| `*_missav_import_report.csv` | 处理报告 |
| `*_女优tag合集.csv` | 从本地库导出的女优 tag 合集 |
| `*_missav_backup.json` | 本次结果备份 |

Raindrop CSV 字段为：

```text
folder,url,title,note,tags,created
```

## 关键规则

- MissAV URL 会优先解析，可从 `/cn/xxx`、`/dm89/cn/xxx`、`/dm96/cn/xxx` 等链接中提取番号。
- Telegram HTML 中的 `message14298`、`MESSAGE-13`、`moodyz` 等噪声会被过滤。
- `需要查找` tag 只应对应 `not_found` 状态；如果链接可访问，请在“整理卡片”或“番号库”中修正状态。
- SQLite 本地库是主数据库，CSV 工作台用于兼容、编辑和迁移外部 CSV。
- 大批量修改前建议先在“备份恢复”里创建备份。

## 项目结构

```text
missav-manager/
├── main.js              # Electron 主进程
├── preload.js           # 预加载脚本
├── renderer/
│   ├── index.html       # 主界面
│   ├── styles.css       # 界面样式
│   └── app.js           # 前端逻辑
├── src/
│   ├── parser.js        # 番号解析与 URL 生成
│   ├── fetcher.js       # 页面状态检查与 tag 提取
│   ├── database.js      # SQLite 本地库
│   ├── csvTools.js      # CSV 解析、校验、导出
│   ├── exporter.js      # Raindrop 导出
│   └── utils.js         # 通用工具
├── assets/              # 图标资源
├── .github/workflows/   # GitHub 自动构建 Release
├── 使用教程.md           # 完整使用教程
├── package.json
└── README.md
```

## 构建与发布

```bash
npm run build
npm run build:portable
```

便携版输出到 `dist/MissAV_Manager_v<版本号>.exe`，请作为 GitHub Release 附件发布，不要提交到源码分支。

仓库包含 GitHub Actions 工作流：推送形如 `v2.16.0` 的标签后，会在 Windows 环境自动构建便携版并创建同名 Release。

```bash
git tag v2.16.0
git push origin v2.16.0
```

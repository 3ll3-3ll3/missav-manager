# v0.5 阶段 0 验证记录

更新时间：2026-07-26
版本：`0.5.0-alpha.1`

## 已实现

- `apps/desktop-v05` 独立 Tauri 2 + Vue 3 + TypeScript 项目；
- 护眼绿、无背景图片的工具首页；
- 首页按工具组织，不把全部工具塞入侧边栏；
- SQLite 原型库启用 WAL、外键、忙等待、FULL 同步和 FTS5；
- 10 万行数据表使用数据库远端分页，每页只读取 100–500 行；
- 编号、来源、状态、标签和备注支持单元格编辑；
- 自由全文搜索、范围选择、分页和当前页 CSV 导出；
- 持久任务和逐项队列，支持开始、暂停、继续与取消；
- 启动时将遗留的运行任务改为暂停、运行项目改回等待；
- v0.4.5 SQLite 副本只读分析，输出完整性、表规模和候选映射；
- 数据库分析页没有正式迁移按钮。

## 隔离保证

- 根目录 v0.4.5 Electron 应用不被替换；
- 新应用标识：`com.wjl.tg-content-toolbox.next`；
- 新原型库：Windows 应用数据目录中的 `prototype-v05.sqlite`；
- Rust 单元测试全部使用系统临时目录；
- 旧库分析使用只读打开和 `PRAGMA query_only=ON`；
- 当前阶段不读取、复制、升级或清空正式数据库。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Vue/TypeScript 类型检查 | 通过 |
| Rust `cargo check` | 通过 |
| SQLite 生成、查询和单元格更新 | 通过 |
| 任务中断恢复 | 通过 |
| 旧库只读分析 | 通过 |
| 100,000 行事务生成与代表性查询 | 通过，测试机约 4.22 秒 |
| Vite 生产构建 | 通过 |
| Tauri Windows release 编译 | 通过，裸 EXE 为 11,088,896 字节 |
| Windows 真实窗口启动 | 通过 |
| 数据页滚动与分页 | 通过 |
| 100,000 行 UI 加载 | 通过 |
| 精确全文搜索 | 通过，100,000 行收敛到 1 行 |
| 任务实时进度与暂停 | 通过，在 182/400 处成功暂停 |
| 迁移页只读警告与禁用状态 | 通过 |

## 当前不是成品的部分

- 海角尚未接入真实过滤、文件输入、Telegram 输入和历史；
- 推特、Bad.news、MissAV 和 123AV 尚未迁入；
- 原型表数据是性能样本，不是正式业务数据；
- 旧库只生成报告，未实现预演迁移和正式切换；
- 尚未生成对外发布的 v0.5 EXE。

阶段 0 已在本机构建出未打包的验证 EXE：

```text
apps/desktop-v05/src-tauri/target/release/tg-content-toolbox-v05.exe
SHA-256: 55E0E20E1178F1AB30201F458B9C5E97FEF8B1B132E6C8C8E9E8B8451C9EC57D
```

该路径属于被 Git 忽略的构建目录；文件仅用于技术验证，不复制到 `dist`，也不作为正式发布包。

## 开发命令

在仓库根目录运行：

```bash
npm install --prefix apps/desktop-v05
npm run v05:check
npm run v05:test
npm run v05:dev
```

只构建前端：

```bash
npm --prefix apps/desktop-v05 run build:web
```

阶段 1 开始前，应先保留此检查点，再实现海角工具的完整垂直链路。

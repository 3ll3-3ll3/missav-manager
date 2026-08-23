# 给网页端 Work 的实施提示词

你是 `3ll3-3ll3/missav-manager` 的云端实现端。本轮目标是把现有私人 Sites 网站接入 Windows/云端统一同步体系，并保持五工具体验与 Windows v0.5.13 对齐。

## 基线与分支

1. 先 `fetch`，以桌面总控提供的 `codex/unified-local-cloud-v1` 最新远端 HEAD 为基线。
2. 新建 `codex/cloud/unified-local-cloud-v1-web`。
3. 不修改、合并、rebase、reset 或强推：
   - `codex/v0.5.13-desktop-stable`
   - `v0.5.13-desktop-baseline`
   - 既有 Windows Release
4. 不把网页端代码机械复制进 Windows 目录。

## 必须先读

- `AGENTS.md`
- `HANDOFF.md`
- `docs/CHATGPT_WORK_SITE_HANDOFF.md`
- `docs/UNIFIED_LOCAL_CLOUD_ARCHITECTURE.md`
- `packages/sync-contract/index.js`
- `apps/sync-service/README.md`
- `apps/web-site/lib/server-store.ts`
- `apps/web-site/lib/server-telegram.ts`
- `apps/web-site/app/workbench.tsx`

## 本轮任务

1. **接入同步网关**
   - 网站只从 Site Secrets 读取 `SYNC_GATEWAY_URL` 与 `SYNC_ADMIN_TOKEN`。
   - 在服务端建立网站 node 身份和设备凭据；浏览器不得接触管理员 Token 或设备 Token。
   - 将 D1 的永久记录、处理批次、结果明细、任务中心、来源/绑定、Telegram 消息/队列/已读状态映射到共享同步协议；MissAV 参考 Tag 与两层黑名单使用 `missav.referenceTags`、`missav.referenceTagBlacklist`、`missav.raindropExportBlacklist` 三个允许同步的 `app_setting` 键，与 Windows 保持相同实体形态。
   - 处理批次原始输入最多同步 64 KiB 预览，并保留 `originalInputTruncated` 标记；不要用被截断的云端预览覆盖执行端仍保存的完整原文。
   - 本地业务写入和 outbox 写入必须同一事务；Pull 应用和游标推进必须同一事务。
   - 支持预览、Push、Pull、双向同步、冲突查看和重试。首次同步必须先预览，不得默认覆盖。

2. **增加全局同步中心**
   - 一级导航新增“同步”。
   - 显示节点、网关状态、待上传、待下载、冲突、最近成功、同步日志和 Telegram 租约。
   - 四个清晰按钮：生成预览、仅 Push、仅 Pull、双向同步。
   - 移除所有“Windows SQLite 与云端 D1 永不双向同步”的旧说明，替换成真实状态和安全边界。

3. **接入 Telegram 来源租约**
   - 个人 API、Bot 拉取、远端编辑/删除检查、标已读之前取得来源租约。
   - 失去租约立即停止，不能推进 checkpoint、offset 或已读位置。
   - 页面明确显示“正在由 Windows 执行”或“正在由网页执行”，允许过期后重试，不允许强抢有效租约。

4. **继续对齐五工具体验**
   - 每个工具：输入 / Telegram 消息 / 结果 / 专用操作 / 历史。
   - 结果页固定提供一行一个的纯文本输出区。
   - 必须有复制所选、复制当前筛选范围、全选当前页、全选全部匹配、TXT、CSV。
   - Twitter 同时展示博主名 list 与主页链接 list；Bad.news/海角展示链接 list；MissAV/123AV 展示番号 list 和链接/任务输出。
   - 不允许只靠表格展示结果，也不允许跨页选择静默截断。

5. **安全与性能**
   - 同步载荷禁止 Token、`api_hash`、Session、密码、Cookie 和 `.env` 值。
   - 每批最多 200 条且不超过 4 MB；十万条使用游标分页和流式/分块处理。
   - CSV 防公式注入、HTML 转义、所有者权限校验、错误日志脱敏。
   - TG 拉取只读取必要字段；数据库批量查重和批量写入，不能逐条往返 D1。

## 测试

- 现有网站 lint、类型检查、生产构建与全部测试。
- 新增：同步协议兼容、重复 Push、断点 Pull、删除墓碑、双端冲突、checkpoint 单调、队列状态、Secret 泄漏、来源租约、十万条分页。
- 不使用真实 Secret 的测试必须自动化。
- Telegram 真实登录、拉取、编辑/删除传播和三种已读策略标记为“待用户 E2E”，不得用构建通过冒充验收。

## 完成标准

- 网站可以在“同步中心”与 Windows 双向同步所列重要实体。
- 同一来源不能由两端同时推进 Telegram 远端状态。
- 两端工具页面输出与选择语义一致，包含直接复制 list。
- 所有自动测试通过，生产构建通过，源码提交并推送；提交号、部署号和源码树一一对应。
- 更新 `HANDOFF.md`，列出真实实现、未验收项、所需 Secrets 名称（只写名称）和下一步桌面任务。

完成后先汇报测试与差异，不要修改稳定桌面分支或 Windows Release。

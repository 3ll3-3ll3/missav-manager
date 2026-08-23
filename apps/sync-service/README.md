# TG 工具箱同步网关

## 当前协议能力

- 一次性 10 位配对码只保存哈希，使用后立即失效。
- 设备令牌只返回一次，网关只保存 SHA-256；Windows 使用 DPAPI 保存。
- 每次 Push 最多 500 条/4 MB；Windows 客户端默认最多 200 条并把请求体控制在 3.5 MB 内。
- operationId 幂等、全局递增 Pull 游标、实体快照、墓碑删除和冲突记录。
- Telegram 来源租约支持取得、续约、释放与过期恢复。
- v1 桌面适配器已覆盖：永久记录、处理批次、结果明细、任务中心、来源、工具绑定、Telegram 消息、工具队列、checkpoint、已读状态和三份 MissAV 规则资料。
- 超大处理原文只同步 64 KiB 预览；完整原文仍保留在创建它的执行端。
- Windows 同步中心支持预览、Push、Pull、双向同步，以及逐条采用云端/保留本地的冲突处理。

## 本地验证

    cd apps/sync-service
    npm ci
    npm run check
    npm test
    $env:WRANGLER_LOG_PATH='.wrangler/wrangler.log'
    npm run deploy:dry -- --config wrangler.example.jsonc

集成测试使用 Miniflare 和真实 D1 API 模拟器，不需要正式 Cloudflare 账号或任何 Secret。

## 正式部署

1. 新建独立 D1，例如 tg-toolbox-sync。
2. 复制 wrangler.example.jsonc 为不入库的实际配置，写入 D1 ID。
3. 运行 D1 migration。
4. 生成高强度 SYNC_ADMIN_TOKEN 并用 Wrangler Secret 保存。
5. 部署 Worker，先验证 /health。
6. 在私人 Sites 中仅配置 Secret 名称 SYNC_GATEWAY_URL 和 SYNC_ADMIN_TOKEN；值不得写入 GitHub。

正式部署前不能给 Windows 用户发配对码。首次汇合必须先备份两端并生成差异预览。

这是 Windows 本地数据库与 Work/Sites 云端数据之间的唯一同步协调层。它不保存 Telegram Token、`api_hash`、验证码、密码、Cookie 或 Telegram Session。

核心职责：

- 一次性设备配对和可撤销设备令牌。
- 幂等增量 Push/Pull、删除墓碑和冲突记录。
- Telegram 来源级执行权租约，避免本地与云端同时推进同一 offset、checkpoint 或已读位置。
- 为本地 SQLite 与云端业务库提供中立的同步序列。

部署时需要：

- D1 绑定：`DB`
- Secret：`SYNC_ADMIN_TOKEN`

不要提交实际 `wrangler.jsonc`、D1 ID、设备令牌或 Secret。先复制 `wrangler.example.jsonc`，在部署环境填写资源 ID。

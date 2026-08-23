# 给网页端 Work 的审计与部署提示词

你是 `3ll3-3ll3/missav-manager` 的云端实施端。桌面总控已经在 `codex/unified-local-cloud-v1` 同时完成共享协议、Windows 同步中心、Cloudflare Worker/D1 网关和 Sites 网站同步接入。本轮目标是审计现有实现、修复有证据的问题并部署，不得另写一套同步系统。

## 基线与保护边界

1. 先 `fetch`，记录 `origin/codex/unified-local-cloud-v1` 的真实 HEAD，以该提交为唯一源码基线。
2. 新建 `codex/cloud/unified-local-cloud-v1-deploy`；不得在稳定桌面分支或生产分支直接开发。
3. 禁止修改、合并、rebase、reset 或强推：
   - `codex/v0.5.13-desktop-stable`
   - `v0.5.13-desktop-baseline`
   - 既有 Windows Release、EXE 与正式本地数据库
4. 不得读取、输出、提交或记录任何 Telegram Token、`api_hash`、Session、验证码、密码、Cookie、设备 Token、管理员 Token 或 `.env` 值。
5. 网站 Secret 只能读取既有 Site Secrets；缺少时只报告 Secret 名称，等待所有者设置。

## 必须先读和核对

- `AGENTS.md`
- `HANDOFF.md`
- `docs/CHATGPT_WORK_SITE_HANDOFF.md`
- `docs/UNIFIED_LOCAL_CLOUD_ARCHITECTURE.md`
- `packages/sync-contract/index.js`
- `apps/sync-service/src/index.mjs`
- `apps/sync-service/migrations/0001_initial.sql`
- `apps/web-site/lib/cloud-sync-schema.ts`
- `apps/web-site/lib/cloud-sync.ts`
- `apps/web-site/app/api/cloud-sync/route.ts`
- `apps/web-site/app/components/cloud-sync-center.tsx`
- `apps/web-site/drizzle/0006_spicy_omega_sentinel.sql`
- `apps/web-site/app/api/telegram/route.ts`
- `apps/web-site/tests/cloud-sync-schema.test.mjs`
- `apps/web-site/tests/cloud-sync-integration.test.mjs`

## 审计任务

逐项用源码和测试确认，不能只引用 HANDOFF 声明：

1. D1 业务写入与 dirty 登记同事务，Pull 应用与游标推进同事务，Pull 不制造回声。
2. 网站设备凭据只在服务端加密保存，管理员 Token 和设备 Token 不返回浏览器。
3. 预览有 30 分钟有效期；预览后本地变化会拒绝执行；Push、Pull、双向、断点、墓碑和冲突取舍真实可用。
4. 三份 MissAV 规则资料是唯一允许同步的设置；Telegram/Raindrop 凭据、Session 和其他设置不能进入载荷。
5. 网站个人 API、Bot、工具同步、历史回拉和标已读在远端操作前取得跨端来源租约；租约丢失时不推进 checkpoint、offset 或已读位置。
6. 5,001 条以上 dirty 数据能分批完整进入 outbox，十万条路径不存在静默截断。
7. 五工具的一行一个 list、复制所选/当前筛选、TXT/CSV、表格选择和历史能力没有被同步改动破坏。
8. 部署前审计曾发现的四项阻断必须以最新 HEAD 复核：
   - Web 与 Windows 的 Telegram 来源自然键都归一为 `default`，网页本地连接别名不会制造重复来源；
   - Web Push 按 UTF-8 JSON 实际字节切分到 3.5 MB，真实 Worker 路径的大载荷测试会产生多个请求；
   - Secret 防护能拒绝普通字符串值中嵌入的 Bot Token、Bearer、登录 Token 或敏感键值；
   - 租约在消息入库后失效时，Bot offset 和个人 checkpoint 均不推进，远端自动已读前也会再次检查。

发现问题时只在云端部署分支修复，必须补自动测试并在汇报中给出证据；没有问题就不要机械重构。

## 自动验证

在不使用真实 Secret 的环境运行：

```text
cd apps/web-site
npx tsc --noEmit
eslint . --ignore-pattern dist --ignore-pattern .next
node --test --test-concurrency=1 tests/*.test.mjs
vinext build

cd ../sync-service
npm run check
npm test
wrangler deploy --dry-run --config wrangler.example.jsonc

cd ../..
npm run check
npm test
cd apps/desktop-v05
npm run build:web
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

必须明确区分：源码验证通过、部署成功、真实 Telegram E2E 通过。三者不能互相代替。

桌面总控已经在 Windows 环境复现 Worker Wrangler dry-run、桌面 `cargo check` 和 Rust `30/30`。若云端运行环境缺少 Rust 或拦截 Wrangler，只能记录为云端环境限制；仍需检查对应日志和本地证据，不得把它改写成源码失败。

## 正式部署（必须先获得所有者明确批准）

1. 创建或选择专用 Cloudflare D1 与 Worker，执行 `apps/sync-service/migrations/0001_initial.sql`。
2. 在 Worker Secret 中设置 `SYNC_ADMIN_TOKEN`，不得把值放入配置文件、日志或聊天。
3. 部署 Worker，记录公开 URL、部署 ID 和对应 Git SHA。
4. 在私人 Site Secrets 中设置：
   - `SYNC_GATEWAY_URL`
   - `SYNC_ADMIN_TOKEN`
5. 对网站 D1 执行包括 `0006_spicy_omega_sentinel.sql` 在内的待执行迁移，再部署 Sites；Git SHA、构建源码树和 Sites 版本必须一一对应。
6. 先用空白/脱敏数据验证 Web→网关→第二设备、第二设备→网关→Web、重复 Push、断点 Pull、删除墓碑、冲突两种处理和租约互斥。
7. 正式库首次双向同步只生成预览并停止，等待所有者确认数量和方向；不得自动执行合并。

## 完成标准

- 自动测试、类型检查、Lint、网站构建、Worker dry-run 和桌面回归全部通过。
- Worker/D1 与私人 Site 实际部署成功，部署版本可追溯到同一 Git SHA。
- 脱敏双端往返、墓碑、冲突和来源租约通过真实 HTTP E2E。
- 真实 Telegram 登录、拉取、编辑/删除传播、三种已读策略及正式首次数据汇合继续标记为“待用户 E2E”，直到所有者亲自验收。
- 更新 `HANDOFF.md`，只写 Secret 名称、真实提交/部署号、迁移结果、证据和剩余风险；禁止写任何 Secret 值。
- 完成后先汇报并等待，不修改稳定桌面分支、标签或 Windows Release。

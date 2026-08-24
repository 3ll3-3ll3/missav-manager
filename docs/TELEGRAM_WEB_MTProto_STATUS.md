# 网站 Telegram 个人 API 状态与验收门槛

更新日期：2026-08-01

## 当前结论

Telegram 网站功能尚未完成。当前已实现 Bot API 增量、Telegram 官方 JSON 导入、来源多对多绑定、消息去重和工具独立队列；个人账号 MTProto 已实现最小登录链路，但尚未由所有者在生产站完成真实账号验收，来源发现、历史、增量和已读策略也仍未实现。

最小登录链路现包含二维码自动刷新/轮询、国际手机号、验证码、两步验证、超时、取消解锁、AES-GCM 加密 Session、跨请求恢复以及远端注销与网站端删除。临时登录 Session 和正式 Session 均只以密文存入 D1；数据库表不包含手机号、验证码、密码或二维码 token 字段。

Windows v0.5.13 的个人 API 保持不变，作为独立回退。网站与 Windows 不共享 API 凭据、Session、来源、检查点或已读状态。

## 平台验证记录

- 当前 Site 是 Vinext 生成的 Cloudflare Worker，启用 `nodejs_compat`，持久绑定为 D1。
- Cloudflare 官方运行时支持出站 TCP，但官方同时明确：TCP socket 不能在全局作用域创建并跨请求共享。
- 当前 Sites 项目清单只声明 D1 / R2，不具备用于长连接协调的 Durable Object 绑定。
- 已加入仅所有者可调用的生产探针：它尝试连接 Telegram DC 的 TCP 443，并按 Telegram 官方格式以 `binary` 子协议建立 WSS 握手；不发送 MTProto 数据，也不接触任何凭据。
- TCP / WebSocket 探针通过只证明网络可达；不能证明二维码/手机号登录、多步骤挑战、跨请求状态、Session 恢复或长时间稳定性。
- Worker 直连的最小登录实现采用“每个 HTTP 步骤短连接、加密 Session 跨请求恢复”的方式，不在全局作用域保持 socket。是否足够稳定仍以接下来的生产真实登录与恢复结果为准。

参考：

- Cloudflare Workers TCP sockets: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- Cloudflare Workers `node:net`: https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/
- Cloudflare Durable Objects WebSocket 生命周期: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Telegram MTProto transports: https://core.telegram.org/mtproto/transports

## 完成门槛

- [x] 生产 Site 的 TCP 探针真实通过。
- [x] 生产 Site 的 Telegram WebSocket 探针真实通过。
- [x] 第一轮采用 Site Worker 短连接直连；若真实登录/恢复不稳定再转仅所有者私有 MTProto 后端。
- [x] `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` 只从 Site Secrets 读取，客户端代码不含变量名或值。
- [ ] 二维码登录真实通过，包含过期、刷新、取消和解锁。
- [ ] 国际格式手机号、验证码、两步验证密码登录真实通过。
- [ ] Session 服务端加密保存、恢复登录、注销并删除真实通过。
- [x] 自动安全测试确认数据库结构、客户端、应用日志和枚举错误响应不保存/回显 api_hash、手机号、验证码、密码、二维码内容或 Session；仍待生产抽查。
- [ ] 普通群、超级群、广播频道发现真实通过，来源上限 100 生效。
- [ ] 多工具多来源与同一来源多工具绑定真实通过。
- [ ] 最近消息、指定时间、历史回拉和增量真实通过。
- [ ] 分页读取使用连续检查点；中止和失败不会跳过消息。
- [ ] 来源 ID + 消息 ID 去重及工具独立队列真实通过。
- [ ] `safe_auto`、`never`、`manual` 三种策略真实通过。
- [ ] 历史回拉在三种策略下均不自动标已读。
- [ ] 手动确认按安全 `max_id` 标记已读真实通过。
- [ ] Windows v0.5.13 仍可独立登录和同步，且不受网站 Session 影响。

只有全部必需项完成并保存自动测试与真实账号验收证据后，才能把 Telegram 网站能力改为“完成”。

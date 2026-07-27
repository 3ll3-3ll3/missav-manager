# TG 内容工具箱 v0.5.1（Windows）

## v0.5.1 修复

- Telegram Bot 网络错误不再显示或写入包含 Token 的完整请求网址。
- 读取旧日志时也会即时遮蔽 Telegram Bot Token；已经暴露过的 Token 仍应在 BotFather 中撤销。
- 超长错误信息会在提示框内自动换行，不再横向撑破页面。
- Telegram 连接失败改为简短中文分类提示，便于检查 Clash、代理、DNS 和防火墙。

## 主要变化

- 产品重构为工具箱首页：推特博主、Bad.news、海角、MissAV、123AV 五个入口彼此独立。
- 输入统一支持粘贴和多文件导入；文本工具的结果、输出文本与处理历史独立保存。
- MissAV 与 123AV 分别查询、分别限速；同站操作串行，站点间可以并行。
- 新增 v0.5 永久数据库、FTS 搜索、100k+ 服务端分页、统一 CRUD、自动备份与数据库迁移位置。
- Raindrop 支持任选 Collection 的 Pull、Push、双向同步，全账号番号去重，Pull 也同步所有 Tags。
- Telegram 同时支持个人账号 API 和 Bot API：个人 API 支持扫码、手机号、2FA、Clash SOCKS5、群/超级群/频道、多选绑定及检查点增量；Bot 保留轻量增量入口。
- 123AV 保留 Chrome 扩展、APP 内串行助手、CSV 导出三种账号操作。
- 默认护眼绿色、无背景图；数据库、日志、来源和备份均有独立入口。

## 发布文件

- 文件：[tg-content-toolbox-v05.exe](apps/desktop-v05/src-tauri/target/release/tg-content-toolbox-v05.exe)
- SHA-256：`AF3D4E85AA6E229C0E569635E0854947BFD9A46CAFF722C0092A95B91A896618`
- 文件大小：`19,196,416` 字节（约 18.3 MiB）
- 构建日期：2026-07-27

## 运行要求

- Windows 10/11
- WebView2 Runtime（Windows 11 通常自带）
- 访问 Telegram、MissAV、123AV 或 Raindrop 时，需要你的网络/代理本身可用。

这是未签名的本地工具。SmartScreen 出现提示时，请先核对来源与 SHA-256。应用不会导出或记录 Cookie、密码、浏览器 Storage、Telegram 验证码、二维码 Token 或 Raindrop Token。

若本机 Windows 策略禁止监听 `127.0.0.1` 本地端口，应用会照常启动；仅“Chrome 扩展”账号操作会显示不可用提示，APP 内串行助手和 CSV 导出不受影响。

完整教程见 [README](README.md)。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectFile } from "./helpers/bundle.mjs";

test("Telegram 三层架构把连接、会话绑定和本次选择分开", async () => {
  const settings = await readFile(projectFile("app/components/telegram-settings.tsx"), "utf8");
  const panel = await readFile(projectFile("app/components/telegram-panel.tsx"), "utf8");
  const server = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  const route = await readFile(projectFile("app/api/telegram/route.ts"), "utf8");
  for (const label of ["连接账号", "会话库", "工具绑定", "同步记录", "一次提交全部变化", "safe_auto", "manual"]) assert.match(settings, new RegExp(label));
  for (const label of ["本次来源", "全选搜索结果", "清空本次选择", "管理绑定"]) assert.match(panel, new RegExp(label));
  assert.match(route, /save-bindings/);
  assert.match(server, /telegram_connections/);
  assert.match(server, /telegram_bot_state/);
  assert.match(server, /telegram_messages/);
  assert.match(server, /telegram_tool_queue/);
  assert.match(server, /tool_source_bindings b/);
});

test("工具页面没有独立 Telegram 登录或 Bot 拉取入口", async () => {
  const panel = await readFile(projectFile("app/components/telegram-panel.tsx"), "utf8");
  assert.doesNotMatch(panel, /QRCode|mtprotoAction|start-phone|start-qr|TELEGRAM_|fetch\([^)]*getUpdates/);
  assert.match(panel, /view=tool/);
  assert.match(panel, /sourceIds/);
});

test("全局 Bot 游标与每工具独立队列存在于服务端同步事务中", async () => {
  const server = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  assert.match(server, /getUpdates/);
  assert.match(server, /next_update_offset/);
  assert.match(server, /telegram_tool_queue[\s\S]*tool/);
  assert.match(server, /processed_empty/);
  assert.match(server, /INSERT OR IGNORE INTO telegram_tool_queue/);
  assert.match(server, /verifyTelegramBotWebhook/);
  assert.match(server, /webhook_status/);
  assert.match(server, /event_kind/);
  assert.match(server, /remote_deleted_at/);
});

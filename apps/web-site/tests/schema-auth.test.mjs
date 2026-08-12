import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadModule, projectFile } from "./helpers/bundle.mjs";

const apiResponse=await loadModule("lib/api-response.ts");

test("生产 API 拒绝缺少 ChatGPT 身份头，开发主机仍可本地验收",()=>{
  assert.throws(()=>apiResponse.requireAuthenticated(new Request("https://private.example/api/records")),/ChatGPT/);
  assert.doesNotThrow(()=>apiResponse.requireAuthenticated(new Request("http://localhost/api/records")));
  assert.doesNotThrow(()=>apiResponse.requireAuthenticated(new Request("https://private.example/api/records",{headers:{"oai-authenticated-user-email":"owner@example.com"}})));
});

test("数据库迁移覆盖完整业务语义、唯一约束与分块校验表",async()=>{
  const sql=(await Promise.all(["drizzle/0001_ambitious_bloodscream.sql","drizzle/0002_small_garia.sql","drizzle/0003_glossy_bloodaxe.sql"].map((file)=>readFile(projectFile(file),"utf8")))).join("\n");
  const compatibilityMigration=await readFile(projectFile("drizzle/0004_classy_pixie.sql"),"utf8");
  const store=await readFile(projectFile("lib/server-store.ts"),"utf8");
  for(const table of ["input_sources","tool_source_bindings","telegram_messages","telegram_tool_queue","telegram_message_fingerprints","telegram_accounts","telegram_auth_flows","telegram_connections","telegram_bot_state","telegram_read_states","telegram_sync_runs","telegram_migration_runs","sync_transactions","task_inbox","script_generations","app_logs","data_snapshots","data_snapshot_items","import_batch_chunks"])assert.ok(sql.includes("CREATE TABLE `"+table+"`"),`missing ${table}`);
  assert.match(sql,/import_batch_chunks_batch_index_uq/);assert.match(sql,/telegram_tool_queue_message_tool_uq/);assert.match(sql,/ON DELETE cascade/);
  assert.match(sql,/encrypted_session/);assert.match(sql,/telegram_auth_flows_expires_idx/);
  assert.match(compatibilityMigration,/valid no-op/);assert.match(compatibilityMigration,/SELECT 1/);
  for(const column of ["sync_cursor_message_id","sync_target_message_id","encrypted_challenge","content_hash","remote_edited_at","remote_deleted_at","webhook_status","edited_count","deleted_count","has_more"])assert.match(store,new RegExp(column));
});

test("Secret 变量只在服务端读取，客户端与默认配置不含 Token 值",async()=>{
  const botServer=await readFile(projectFile("lib/server-telegram.ts"),"utf8");const mtServer=await readFile(projectFile("lib/server-mtproto.ts"),"utf8");const client=await readFile(projectFile("app/components/telegram-panel.tsx"),"utf8");const settings=await readFile(projectFile("app/components/telegram-settings.tsx"),"utf8");
  assert.match(botServer,/TELEGRAM_BOT_TOKEN/);assert.match(mtServer,/TELEGRAM_API_ID/);assert.match(mtServer,/TELEGRAM_SESSION_ENCRYPTION_KEY/);
  for(const secretName of ["TELEGRAM_BOT_TOKEN","TELEGRAM_API_ID","TELEGRAM_API_HASH"])assert.doesNotMatch(client,new RegExp(secretName));
  for(const secretName of ["TELEGRAM_BOT_TOKEN","TELEGRAM_API_ID","TELEGRAM_API_HASH"])assert.doesNotMatch(settings,new RegExp(secretName));
  assert.doesNotMatch(botServer,/\d{8,12}:[A-Za-z0-9_-]{20,}/);assert.doesNotMatch(mtServer,/console\.(log|error)|process\.env/);
});

test("Telegram 配置读取期间不再伪装成未配置状态",async()=>{
  const settings=await readFile(projectFile("app/components/telegram-settings.tsx"),"utf8");
  const telegramRoute=await readFile(projectFile("app/api/telegram/route.ts"),"utf8");
  const mtprotoRoute=await readFile(projectFile("app/api/telegram/mtproto/route.ts"),"utf8");
  assert.match(settings,/hubLoadState/);
  assert.match(settings,/mtprotoLoadState/);
  assert.match(settings,/正在检测/);
  assert.match(settings,/读取失败/);
  assert.match(settings,/cache:\s*"no-store"/);
  assert.match(settings,/STATUS_TIMEOUT_MS\s*=\s*20_000/);
  assert.match(settings,/new AbortController\(\)/);
  assert.doesNotMatch(settings,/Promise\.all\(\[loadHub\(\), loadMtproto\(\)\]\)/);
  assert.match(settings,/setMtproto\(nextHub\.mtproto \|\| EMPTY_MTPROTO\)/);
  assert.match(telegramRoute,/mtproto:\s*await mtprotoStatus\(\)/);
  assert.match(telegramRoute,/cache-control[^\n]+no-store/i);
  assert.match(mtprotoRoute,/cache-control[^\n]+no-store/i);
});

test("Worker 冷启动优先执行只读 schema 探针，不重复争抢 D1 写锁",async()=>{
  const store=await readFile(projectFile("lib/server-store.ts"),"utf8");
  const probeIndex=store.indexOf("await probeCurrentSchema(db)");
  const compatibilityIndex=store.indexOf("await applyTelegramHubSchemaCompatibility(db)");
  const ddlIndex=store.indexOf("const statements = [");
  assert.ok(probeIndex>0&&ddlIndex>probeIndex,"read-only schema probe must precede legacy DDL fallback");
  assert.ok(compatibilityIndex>probeIndex&&ddlIndex>compatibilityIndex,"targeted Telegram schema repair must precede legacy DDL fallback");
  assert.match(store,/probeBaseSchema/);
  assert.match(store,/TELEGRAM_HUB_COMPATIBILITY_COLUMNS/);
  assert.match(store,/SELECT connection_id FROM telegram_connections LIMIT 1/);
  assert.match(store,/Hosted migrations own the normal schema lifecycle/);
});

test("产品状态不再把 Telegram 个人 API 宣称为 Windows 独占",async()=>{
  const workbench=await readFile(projectFile("app/workbench.tsx"),"utf8");
  const telegramPanel=await readFile(projectFile("app/components/telegram-panel.tsx"),"utf8");
  const settings=await readFile(projectFile("app/components/telegram-settings.tsx"),"utf8");
  assert.doesNotMatch(workbench,/Telegram 个人账号 API、扫码\/手机号登录、远端标已读。/);
  assert.match(workbench,/WEB \+ WINDOWS/);
  assert.match(settings,/Telegram 三层连接模型/);
  for(const label of ["生成登录二维码","发送验证码","提交验证码","提交两步验证密码","取消并解锁","退出并删除网站 Session"])assert.match(settings,new RegExp(label));
  for(const forbidden of ["生成登录二维码","发送验证码","TELEGRAM_BOT_TOKEN"])assert.doesNotMatch(telegramPanel,new RegExp(forbidden));
});

test("MTProto 登录 API 覆盖二维码、手机号、验证码、2FA、恢复、取消与注销",async()=>{
  const route=await readFile(projectFile("app/api/telegram/mtproto/route.ts"),"utf8");
  const server=await readFile(projectFile("lib/server-mtproto.ts"),"utf8");
  const socket=await readFile(projectFile("lib/cloudflare-telegram-socket.ts"),"utf8");
  for(const action of ["start-phone","submit-code","submit-password","start-qr","poll-qr","restore","cancel","logout"])assert.match(route,new RegExp(`input\\.action === "${action}"`));
  assert.match(route,/requireAuthenticated/);
  assert.match(server,/hasMtprotoError\(error, "SESSION_PASSWORD_NEEDED"\)/);
  assert.match(server,/AUTH_TOKEN_EXPIRED/);
  assert.match(server,/CloudflareTelegramSocket/);
  assert.match(server,/telegram_websocket/);
  assert.match(server,/cloudflare_tcp_with_websocket_fallback/);
  assert.match(socket,/from "cloudflare:sockets"/);
  assert.match(socket,/socket\.readable\.getReader/);
  assert.match(socket,/socket\.writable\.getWriter/);
  assert.match(server,/transport:\s*MTPROTO_TRANSPORT/);
  assert.match(server,/writeErrorLog/);
  assert.match(server,/traceId/);
  assert.match(server,/attemptDiagnostics/);
  assert.match(server,/describeMtprotoError/);
  assert.match(server,/requestRetries:\s*5/);
  assert.doesNotMatch(server,/requestRetries:\s*1\b/);
  assert.match(server,/logger\.handler/);
  assert.match(server,/clientLog/);
  assert.match(server,/executionModel:\s*"request_scoped"/);
  assert.match(server,/liveConnection:\s*false/);
});

test("MTProto 服务端不持久化手机号、验证码、密码或二维码内容",async()=>{
  const server=await readFile(projectFile("lib/server-mtproto.ts"),"utf8");
  const schema=await readFile(projectFile("drizzle/0002_small_garia.sql"),"utf8");
  for(const column of ["phone","code","password","qr_url","qr_token"])assert.doesNotMatch(schema,new RegExp("`"+column+"`","i"));
  assert.doesNotMatch(server,/localStorage|sessionStorage/);
  assert.match(server,/Session 已加密保存/);
  assert.match(server,/encrypted_challenge/);
  assert.doesNotMatch(server,/JSON\.stringify\(input\.challenge \?\? \{\}\)/);
  assert.match(server,/DELETE FROM telegram_auth_flows/);
  assert.match(server,/DELETE FROM telegram_accounts/);
});

test("MTProto 平台探针不读取凭据且只使用固定 Telegram 端点",async()=>{
  const probe=await readFile(projectFile("lib/server-mtproto-probe.ts"),"utf8");
  assert.match(probe,/149\.154\.167\.51/);
  assert.match(probe,/wss:\/\/venus\.web\.telegram\.org\/apiws/);
  assert.match(probe,/"binary"/);
  assert.match(probe,/network_only/);
  for(const forbidden of ["TELEGRAM_API_HASH","TELEGRAM_API_ID","TELEGRAM_BOT_TOKEN","process.env","env."])assert.doesNotMatch(probe,new RegExp(forbidden.replace(".","\\."),"i"));
});

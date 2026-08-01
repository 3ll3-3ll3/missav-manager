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
  const sql=await readFile(projectFile("drizzle/0001_ambitious_bloodscream.sql"),"utf8");
  for(const table of ["input_sources","tool_source_bindings","telegram_messages","telegram_tool_queue","telegram_message_fingerprints","sync_transactions","task_inbox","script_generations","app_logs","data_snapshots","data_snapshot_items","import_batch_chunks"])assert.ok(sql.includes("CREATE TABLE `"+table+"`"),`missing ${table}`);
  assert.match(sql,/import_batch_chunks_batch_index_uq/);assert.match(sql,/telegram_tool_queue_message_tool_uq/);assert.match(sql,/ON DELETE cascade/);
});

test("Secret 变量只在服务端读取，客户端与默认配置不含 Token 值",async()=>{
  const server=await readFile(projectFile("lib/server-telegram.ts"),"utf8");const client=await readFile(projectFile("app/components/telegram-panel.tsx"),"utf8");
  assert.match(server,/TELEGRAM_BOT_TOKEN/);assert.doesNotMatch(client,/TELEGRAM_BOT_TOKEN/);assert.doesNotMatch(server,/\d{8,12}:[A-Za-z0-9_-]{20,}/);
});

test("产品状态不再把 Telegram 个人 API 宣称为 Windows 独占",async()=>{
  const workbench=await readFile(projectFile("app/workbench.tsx"),"utf8");
  const telegramPanel=await readFile(projectFile("app/components/telegram-panel.tsx"),"utf8");
  assert.doesNotMatch(workbench,/Telegram 个人账号 API、扫码\/手机号登录、远端标已读。/);
  assert.match(workbench,/WEB \+ WINDOWS/);
  assert.match(telegramPanel,/网站正式目标/);
  assert.match(telegramPanel,/尚未完成/);
});

test("MTProto 平台探针不读取凭据且只使用固定 Telegram 端点",async()=>{
  const probe=await readFile(projectFile("lib/server-mtproto-probe.ts"),"utf8");
  assert.match(probe,/149\.154\.167\.51/);
  assert.match(probe,/wss:\/\/venus\.web\.telegram\.org\/apiws/);
  assert.match(probe,/"binary"/);
  assert.match(probe,/network_only/);
  for(const forbidden of ["TELEGRAM_API_HASH","TELEGRAM_API_ID","TELEGRAM_BOT_TOKEN","process.env","env."])assert.doesNotMatch(probe,new RegExp(forbidden.replace(".","\\."),"i"));
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadModule, projectFile } from "./helpers/bundle.mjs";

const schema = await loadModule("lib/cloud-sync-schema.ts");

async function databaseWithSchema() {
  const database = new DatabaseSync(":memory:");
  for (let index = 0; index <= 6; index += 1) {
    const files = {
      0: "0000_fantastic_paper_doll.sql",
      1: "0001_ambitious_bloodscream.sql",
      2: "0002_small_garia.sql",
      3: "0003_glossy_bloodaxe.sql",
      4: "0004_classy_pixie.sql",
      5: "0005_workflow_contract.sql",
      6: "0006_spicy_omega_sentinel.sql",
    };
    const sql = await readFile(projectFile(`drizzle/${files[index]}`), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", "\n"));
  }
  // These two legacy columns are added by server-store's bounded runtime
  // compatibility step because older production D1 databases already contain
  // them and SQLite has no portable ADD COLUMN IF NOT EXISTS.
  database.exec("ALTER TABLE input_sources ADD COLUMN sync_cursor_message_id TEXT NOT NULL DEFAULT ''");
  database.exec("ALTER TABLE input_sources ADD COLUMN sync_target_message_id TEXT NOT NULL DEFAULT ''");
  database.exec("ALTER TABLE telegram_messages ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'message'");
  database.exec("ALTER TABLE telegram_messages ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  database.exec("ALTER TABLE telegram_messages ADD COLUMN remote_edited_at TEXT NOT NULL DEFAULT ''");
  database.exec("ALTER TABLE telegram_messages ADD COLUMN remote_deleted_at TEXT NOT NULL DEFAULT ''");
  for (const statement of schema.CLOUD_SYNC_SCHEMA_STATEMENTS) database.exec(statement);
  return database;
}

test("云端业务写入、更新和删除由同事务触发器登记，Pull 抑制不会制造回声", async () => {
  const database = await databaseWithSchema();
  const timestamp = "2026-08-23T10:00:00.000Z";
  database.prepare(
    `INSERT INTO permanent_records(id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("record-1", "missav", "ABF-001", "ABF-001", "", "new", "[]", "[]", "[]", "", "", "", "{}", timestamp, timestamp);
  let dirty = database.prepare("SELECT table_name,action,row_json FROM cloud_sync_dirty ORDER BY id").all();
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].table_name, "permanent_records");
  assert.equal(JSON.parse(dirty[0].row_json).recordKey, "ABF-001");

  database.exec("UPDATE cloud_sync_runtime SET suppress_outbox=1 WHERE id=1");
  database.prepare("UPDATE permanent_records SET status='remote' WHERE id='record-1'").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM cloud_sync_dirty").get().count, 1);

  database.exec("UPDATE cloud_sync_runtime SET suppress_outbox=0 WHERE id=1");
  database.prepare("DELETE FROM permanent_records WHERE id='record-1'").run();
  dirty = database.prepare("SELECT table_name,action,row_json FROM cloud_sync_dirty ORDER BY id").all();
  assert.equal(dirty.length, 2);
  assert.equal(dirty[1].action, "delete");
  assert.equal(JSON.parse(dirty[1].row_json).recordKey, "ABF-001");
});

test("规则库只登记三项允许同步的设置，初始化种子不会读取 Secret 设置", async () => {
  const database = await databaseWithSchema();
  const timestamp = "2026-08-23T10:00:00.000Z";
  const insert = database.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)");
  insert.run("telegram.api_hash", JSON.stringify("must-not-sync"), timestamp);
  insert.run("referenceTags", JSON.stringify(["女优A"]), timestamp);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM cloud_sync_dirty").get().count, 1);
  assert.equal(database.prepare("SELECT row_key FROM cloud_sync_dirty").get().row_key, "referenceTags");

  database.exec("DELETE FROM cloud_sync_dirty");
  for (const statement of schema.CLOUD_SYNC_SEED_STATEMENTS) database.exec(statement);
  const seeded = database.prepare("SELECT table_name,row_key,row_json FROM cloud_sync_dirty ORDER BY id").all();
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].row_key, "referenceTags");
  assert.equal(JSON.parse(seeded[0].row_json).valueJson, JSON.stringify(["女优A"]));
});

test("跨端同步界面和 Telegram 来源租约接入均存在", async () => {
  const [workbench, center, route, telegramRoute, service] = await Promise.all([
    readFile(projectFile("app/workbench.tsx"), "utf8"),
    readFile(projectFile("app/components/cloud-sync-center.tsx"), "utf8"),
    readFile(projectFile("app/api/cloud-sync/route.ts"), "utf8"),
    readFile(projectFile("app/api/telegram/route.ts"), "utf8"),
    readFile(projectFile("lib/cloud-sync.ts"), "utf8"),
  ]);
  assert.match(workbench, /id: "sync"/);
  for (const label of ["生成同步预览", "仅 Push", "仅 Pull", "双向同步", "冲突与重试"]) assert.ok(center.includes(label));
  assert.match(route, /requireAuthenticated/);
  assert.match(service, /SYNC_GATEWAY_URL/);
  assert.match(service, /SYNC_ADMIN_TOKEN/);
  assert.match(service, /withCloudTelegramSourceLeases/);
  assert.match(telegramRoute, /withCloudTelegramSourceLeases/);
  assert.doesNotMatch(center, /deviceToken|adminToken/);
});

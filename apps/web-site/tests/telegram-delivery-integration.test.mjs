import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { projectFile } from "./helpers/bundle.mjs";

class TestPreparedStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestPreparedStatement(this.database, this.sql, values);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  executeForBatch() {
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) {
      return { results: this.database.prepare(this.sql).all(...this.values), success: true, meta: { changes: 0 } };
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestPreparedStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.executeForBatch());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function loadTelegramServer(env) {
  globalThis.__TELEGRAM_TEST_ENV__ = env;
  const entry = fileURLToPath(projectFile("lib/server-telegram.ts"));
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    plugins: [
      {
        name: "cloudflare-test-env",
        setup(buildApi) {
          buildApi.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "cloudflare-test-env" }));
          buildApi.onLoad({ filter: /.*/, namespace: "cloudflare-test-env" }, () => ({ contents: "export const env = globalThis.__TELEGRAM_TEST_ENV__;", loader: "js" }));
          buildApi.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw-text" }));
          buildApi.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))}`, loader: "js" }));
        },
      },
    ],
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`);
}

async function applySchema(database) {
  const files = [
    "drizzle/0000_fantastic_paper_doll.sql",
    "drizzle/0001_ambitious_bloodscream.sql",
    "drizzle/0002_small_garia.sql",
    "drizzle/0003_glossy_bloodaxe.sql",
    "drizzle/0004_classy_pixie.sql",
  ];
  for (const file of files) {
    const sql = await readFile(projectFile(file), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", "\n"));
  }
}

test("一个来源只落一份消息，并向两个工具生成独立队列；编辑和删除会同步生命周期", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const server = await loadTelegramServer({ DB: new TestD1Database(database) });
  const base = {
    sourceKey: "-1001001",
    sourceName: "合成频道",
    connectionId: "telegram-personal",
    chatType: "channel",
    username: "synthetic_channel",
    messageDate: "2026-08-12T00:00:00.000Z",
  };

  await server.ingestTelegramMessages([{ ...base, messageId: "1", text: "建立来源" }]);
  const source = database.prepare("SELECT id FROM input_sources WHERE external_chat_id=?").get(base.sourceKey);
  const insertBinding = database.prepare("INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)");
  insertBinding.run("binding-twitter", source.id, "twitter", "cached", 0, "", "", base.messageDate);
  insertBinding.run("binding-missav", source.id, "missav", "cached", 0, "", "", base.messageDate);

  const inserted = await server.ingestTelegramMessages([{ ...base, messageId: "2", text: "ABF-354 @alice_test" }]);
  assert.equal(inserted.inserted, 1);
  assert.equal(inserted.queues, 2);
  const message = database.prepare("SELECT id FROM telegram_messages WHERE source_id=? AND message_id='2'").get(source.id);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE telegram_message_id=?").get(message.id).count, 2);

  database.prepare("UPDATE telegram_tool_queue SET status='processed' WHERE telegram_message_id=? AND tool='twitter'").run(message.id);
  const duplicate = await server.ingestTelegramMessages([{ ...base, messageId: "2", text: "ABF-354 @alice_test" }]);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM telegram_messages WHERE source_id=? AND message_id='2'").get(source.id).count, 1);

  const edited = await server.ingestTelegramMessages([{ ...base, messageId: "2", text: "ABF-355 @alice_test", eventKind: "edited", editedAt: "2026-08-12T00:01:00.000Z" }]);
  assert.equal(edited.edited, 1);
  assert.equal(database.prepare("SELECT body FROM telegram_messages WHERE id=?").get(message.id).body, "ABF-355 @alice_test");
  assert.deepEqual(database.prepare("SELECT tool,status FROM telegram_tool_queue WHERE telegram_message_id=? ORDER BY tool").all(message.id).map((row) => ({ ...row })), [
    { tool: "missav", status: "pending" },
    { tool: "twitter", status: "pending" },
  ]);

  const removed = await server.ingestTelegramMessages([{ ...base, messageId: "2", text: "", eventKind: "deleted", deletedAt: "2026-08-12T00:02:00.000Z" }]);
  assert.equal(removed.deleted, 1);
  const tombstone = database.prepare("SELECT body,event_kind,remote_deleted_at FROM telegram_messages WHERE id=?").get(message.id);
  assert.equal(tombstone.body, "");
  assert.equal(tombstone.event_kind, "deleted");
  assert.match(tombstone.remote_deleted_at, /^2026-08-12T00:02:00/);
  assert.deepEqual(database.prepare("SELECT DISTINCT status FROM telegram_tool_queue WHERE telegram_message_id=?").all(message.id).map((row) => ({ ...row })), [{ status: "deleted" }]);

  const duplicateDelete = await server.ingestTelegramMessages([{ ...base, messageId: "2", text: "", eventKind: "deleted", deletedAt: "2026-08-12T00:03:00.000Z" }]);
  assert.equal(duplicateDelete.duplicates, 1);
  assert.equal(duplicateDelete.deleted, 0);
  assert.match(database.prepare("SELECT remote_deleted_at FROM telegram_messages WHERE id=?").get(message.id).remote_deleted_at, /^2026-08-12T00:02:00/);

  delete globalThis.__TELEGRAM_TEST_ENV__;
  database.close();
});

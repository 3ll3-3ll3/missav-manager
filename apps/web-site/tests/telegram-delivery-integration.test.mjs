import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { loadModule, projectFile } from "./helpers/bundle.mjs";

class TestPreparedStatement {
  constructor(database, sql, values = [], metrics = null) {
    this.database = database;
    this.sql = sql;
    this.values = values;
    this.metrics = metrics;
  }

  bind(...values) {
    return new TestPreparedStatement(
      this.database,
      this.sql,
      values,
      this.metrics,
    );
  }

  async all() {
    if (this.metrics) {
      this.metrics.requests += 1;
      this.metrics.statements += 1;
    }
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async first() {
    if (this.metrics) {
      this.metrics.requests += 1;
      this.metrics.statements += 1;
    }
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async run() {
    if (this.metrics) {
      this.metrics.requests += 1;
      this.metrics.statements += 1;
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  executeForBatch() {
    if (this.metrics) this.metrics.statements += 1;
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) {
      return {
        results: this.database.prepare(this.sql).all(...this.values),
        success: true,
        meta: { changes: 0 },
      };
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.metrics = { requests: 0, batches: 0, statements: 0 };
  }

  prepare(sql) {
    return new TestPreparedStatement(this.database, sql, [], this.metrics);
  }

  async batch(statements) {
    this.metrics.requests += 1;
    this.metrics.batches += 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) =>
        statement.executeForBatch(),
      );
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  resetMetrics() {
    this.metrics = { requests: 0, batches: 0, statements: 0 };
  }
}

async function loadServer(entryPath, env) {
  globalThis.__TELEGRAM_TEST_ENV__ = env;
  const entry = fileURLToPath(projectFile(entryPath));
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
          buildApi.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "cloudflare-test-env",
          }));
          buildApi.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
            path: "sockets",
            namespace: "cloudflare-test-sockets",
          }));
          buildApi.onLoad(
            { filter: /.*/, namespace: "cloudflare-test-env" },
            () => ({
              contents: "export const env = globalThis.__TELEGRAM_TEST_ENV__;",
              loader: "js",
            }),
          );
          buildApi.onLoad(
            { filter: /.*/, namespace: "cloudflare-test-sockets" },
            () => ({
              contents: "export function connect(){throw new Error('cloudflare socket unavailable in unit test');}",
              loader: "js",
            }),
          );
          buildApi.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
            namespace: "raw-text",
          }));
          buildApi.onLoad(
            { filter: /.*/, namespace: "raw-text" },
            async (args) => ({
              contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))}`,
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const source = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

const loadTelegramServer = (env) => loadServer("lib/server-telegram.ts", env);
const loadAuditServer = (env) => loadServer("lib/server-audit.ts", env);
const loadStoreServer = (env) => loadServer("lib/server-store.ts", env);
const telegram = await loadModule("lib/telegram.ts");

async function applySchema(database) {
  const files = [
    "drizzle/0000_fantastic_paper_doll.sql",
    "drizzle/0001_ambitious_bloodscream.sql",
    "drizzle/0002_small_garia.sql",
    "drizzle/0003_glossy_bloodaxe.sql",
    "drizzle/0004_classy_pixie.sql",
    "drizzle/0005_workflow_contract.sql",
  ];
  for (const file of files) {
    const sql = await readFile(projectFile(file), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", "\n"));
  }
  database.exec("PRAGMA foreign_keys=ON");
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

  await server.ingestTelegramMessages([
    { ...base, messageId: "1", text: "建立来源" },
  ]);
  const source = database
    .prepare("SELECT id FROM input_sources WHERE external_chat_id=?")
    .get(base.sourceKey);
  const insertBinding = database.prepare(
    "INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insertBinding.run(
    "binding-twitter",
    source.id,
    "twitter",
    "cached",
    0,
    "",
    "",
    base.messageDate,
  );
  insertBinding.run(
    "binding-missav",
    source.id,
    "missav",
    "cached",
    0,
    "",
    "",
    base.messageDate,
  );

  const twitterScope = await server.resolveBoundToolSyncSources({
    tool: "twitter",
    sourceIds: [source.id],
  });
  assert.deepEqual(twitterScope.personalSourceIds, [source.id]);
  await assert.rejects(
    () =>
      server.resolveBoundToolSyncSources({
        tool: "av123",
        sourceIds: [source.id],
      }),
    /未绑定到当前工具/,
  );

  const inserted = await server.ingestTelegramMessages([
    { ...base, messageId: "2", text: "ABF-354 @alice_test" },
  ]);
  assert.equal(inserted.inserted, 1);
  assert.equal(inserted.queues, 2);
  const message = database
    .prepare(
      "SELECT id FROM telegram_messages WHERE source_id=? AND message_id='2'",
    )
    .get(source.id);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE telegram_message_id=?",
      )
      .get(message.id).count,
    2,
  );
  const twitterQueue = database
    .prepare(
      "SELECT id FROM telegram_tool_queue WHERE telegram_message_id=? AND tool='twitter'",
    )
    .get(message.id);
  await assert.rejects(
    () =>
      server.resolveTelegramQueueSelection({
        tool: "missav",
        mode: "ids",
        queueIds: [twitterQueue.id],
      }),
    /绑定已变化/,
  );
  await server.ingestTelegramMessages([
    { ...base, messageId: "3", text: "Se #sex80000" },
  ]);
  const twitterVisible = await server.listTelegramQueue({
    tool: "twitter",
    sourceIds: [source.id],
    status: "pending",
  });
  assert.equal(twitterVisible.total, 1);
  assert.equal(twitterVisible.rows[0].message_id, "2");

  database
    .prepare(
      "UPDATE telegram_tool_queue SET status='processed' WHERE telegram_message_id=? AND tool='twitter'",
    )
    .run(message.id);
  const duplicate = await server.ingestTelegramMessages([
    { ...base, messageId: "2", text: "ABF-354 @alice_test" },
  ]);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM telegram_messages WHERE source_id=? AND message_id='2'",
      )
      .get(source.id).count,
    1,
  );

  const missavQueue = database
    .prepare(
      "SELECT id FROM telegram_tool_queue WHERE telegram_message_id=? AND tool='missav'",
    )
    .get(message.id);
  const queueChange = await server.updateTelegramQueue(
    [missavQueue.id],
    "ignored",
  );
  assert.equal(queueChange.changed, 1);
  assert.ok(queueChange.snapshotId);
  assert.equal(
    database
      .prepare("SELECT status FROM telegram_tool_queue WHERE id=?")
      .get(missavQueue.id).status,
    "ignored",
  );
  const audit = await loadAuditServer({ DB: new TestD1Database(database) });
  assert.equal(
    (await audit.restoreSnapshot(queueChange.snapshotId)).restored,
    2,
  );
  assert.equal(
    database
      .prepare("SELECT status FROM telegram_tool_queue WHERE id=?")
      .get(missavQueue.id).status,
    "pending",
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE telegram_message_id=?",
      )
      .get(message.id).count,
    2,
  );

  const local = await server.createTelegramLocalQueueMessage({
    tool: "twitter",
    sourceId: source.id,
    text: "本地测试 #Alice_Dev",
    messageDate: "2026-08-12T00:00:30.000Z",
  });
  assert.equal(local.candidateCount, 1);
  assert.match(local.candidatePreview, /Alice_Dev/);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE id=?")
      .get(local.queueId).count,
    1,
  );
  const localDelete = await server.deleteTelegramQueueRows("twitter", [
    local.queueId,
  ]);
  assert.equal(localDelete.deleted, 1);
  assert.ok(localDelete.snapshotId);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE id=?")
      .get(local.queueId).count,
    0,
  );
  assert.equal((await audit.restoreSnapshot(localDelete.snapshotId)).restored, 2);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE id=?")
      .get(local.queueId).count,
    1,
  );

  const edited = await server.ingestTelegramMessages([
    {
      ...base,
      messageId: "2",
      text: "ABF-355 @alice_test",
      eventKind: "edited",
      editedAt: "2026-08-12T00:01:00.000Z",
    },
  ]);
  assert.equal(edited.edited, 1);
  assert.equal(
    database
      .prepare("SELECT body FROM telegram_messages WHERE id=?")
      .get(message.id).body,
    "ABF-355 @alice_test",
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT tool,status FROM telegram_tool_queue WHERE telegram_message_id=? ORDER BY tool",
      )
      .all(message.id)
      .map((row) => ({ ...row })),
    [
      { tool: "missav", status: "pending" },
      { tool: "twitter", status: "pending" },
    ],
  );

  const removed = await server.ingestTelegramMessages([
    {
      ...base,
      messageId: "2",
      text: "",
      eventKind: "deleted",
      deletedAt: "2026-08-12T00:02:00.000Z",
    },
  ]);
  assert.equal(removed.deleted, 1);
  const tombstone = database
    .prepare(
      "SELECT body,event_kind,remote_deleted_at FROM telegram_messages WHERE id=?",
    )
    .get(message.id);
  assert.equal(tombstone.body, "");
  assert.equal(tombstone.event_kind, "deleted");
  assert.match(tombstone.remote_deleted_at, /^2026-08-12T00:02:00/);
  assert.deepEqual(
    database
      .prepare(
        "SELECT DISTINCT status FROM telegram_tool_queue WHERE telegram_message_id=?",
      )
      .all(message.id)
      .map((row) => ({ ...row })),
    [{ status: "deleted" }],
  );
  await assert.rejects(
    () => server.updateTelegramQueue([twitterQueue.id], "pending"),
    /远端已删除消息只保留审计/,
  );

  const duplicateDelete = await server.ingestTelegramMessages([
    {
      ...base,
      messageId: "2",
      text: "",
      eventKind: "deleted",
      deletedAt: "2026-08-12T00:03:00.000Z",
    },
  ]);
  assert.equal(duplicateDelete.duplicates, 1);
  assert.equal(duplicateDelete.deleted, 0);
  assert.match(
    database
      .prepare("SELECT remote_deleted_at FROM telegram_messages WHERE id=?")
      .get(message.id).remote_deleted_at,
    /^2026-08-12T00:02:00/,
  );

  delete globalThis.__TELEGRAM_TEST_ENV__;
  database.close();
});

test("Telegram 处理返回实际进度和结果，正文清理后的记录默认从消息工作表隐藏", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const server = await loadTelegramServer({ DB: new TestD1Database(database) });
  const base = {
    sourceKey: "-1002002",
    sourceName: "Bad.news 合成频道",
    connectionId: "telegram-personal",
    chatType: "channel",
    username: "badnews_fixture",
    messageDate: "2026-08-12T01:00:00.000Z",
  };

  await server.ingestTelegramMessages([
    { ...base, messageId: "1", text: "建立来源" },
  ]);
  const source = database
    .prepare("SELECT id FROM input_sources WHERE external_chat_id=?")
    .get(base.sourceKey);
  database
    .prepare(
      "INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      "binding-badnews",
      source.id,
      "badnews",
      "cached",
      0,
      "",
      "",
      base.messageDate,
    );
  await server.ingestTelegramMessages([
    {
      ...base,
      messageId: "2",
      text: telegram.telegramMessageText({
        caption: "点击查看帖子",
        caption_entities: [
          { type: "text_link", url: "https://bad.news/t/123456?from=telegram" },
        ],
      }),
    },
    { ...base, messageId: "3", text: "Se #sex80000" },
  ]);
  const queue = database
    .prepare(
      "SELECT q.id FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id WHERE q.tool='badnews' AND m.message_id='2'",
    )
    .get();
  const noiseQueue = database
    .prepare(
      "SELECT q.id FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id WHERE q.tool='badnews' AND m.message_id='3'",
    )
    .get();
  const before = await server.listTelegramQueue({
    tool: "badnews",
    sourceIds: [source.id],
    status: "pending",
  });
  assert.equal(before.total, 1);
  assert.equal(before.rows[0].message_id, "2");
  assert.equal(before.rows[0].candidate_count, 1);
  assert.match(before.rows[0].candidate_preview, /https:\/\/bad\.news\/t\/123456/);
  assert.deepEqual(
    await server.resolveTelegramQueueSelection({
      tool: "badnews",
      mode: "all",
      sourceIds: [source.id],
      status: "pending",
    }),
    [queue.id],
  );
  assert.deepEqual(
    await server.resolveTelegramQueueSelection({
      tool: "badnews",
      mode: "ids",
      queueIds: [noiseQueue.id],
    }),
    [noiseQueue.id],
  );
  const progress = [];
  const result = await server.processTelegramQueue({
    tool: "badnews",
    queueIds: [queue.id],
    deleteBody: true,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.selected, 1);
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].primaryValue, "https://bad.news/t/123456");
  assert.ok(result.runId);
  assert.ok(
    progress.some(
      (event) =>
        event.phase === "processing" &&
        event.current === 1 &&
        event.total === 1,
    ),
  );
  assert.equal(progress.at(-1).phase, "completed");
  assert.equal(
    database
      .prepare("SELECT body FROM telegram_messages WHERE message_id='2'")
      .get().body,
    "",
  );
  assert.deepEqual(
    await server.resolveTelegramQueueSelection({
      tool: "badnews",
      mode: "ids",
      queueIds: [queue.id],
    }),
    [queue.id],
  );

  await server.updateTelegramQueue([queue.id], "pending");
  database
    .prepare(
      "UPDATE telegram_messages SET body_deleted_at='' WHERE message_id='2'",
    )
    .run();
  const visible = await server.listTelegramQueue({
    tool: "badnews",
    sourceIds: [source.id],
    status: "pending",
  });
  assert.equal(visible.total, 0);
  const audit = await server.listTelegramQueue({
    tool: "badnews",
    sourceIds: [source.id],
    status: "pending",
    includeCleaned: true,
    includeNoise: true,
  });
  assert.equal(audit.total, 2);
  database
    .prepare("UPDATE telegram_tool_queue SET status='error' WHERE id=?")
    .run(noiseQueue.id);
  const errors = await server.listTelegramQueue({
    tool: "badnews",
    sourceIds: [source.id],
    status: "pending",
    errorOnly: true,
    includeCleaned: true,
    includeNoise: true,
  });
  assert.equal(errors.total, 1);
  assert.equal(errors.rows[0].id, noiseQueue.id);

  delete globalThis.__TELEGRAM_TEST_ENV__;
  database.close();
});

test("事务式提取同时提交运行、结果、永久记录和任务；最终提交失败不留下半历史", async () => {
  const successDatabase = new DatabaseSync(":memory:");
  await applySchema(successDatabase);
  const successStore = await loadStoreServer({
    DB: new TestD1Database(successDatabase),
  });
  const saved = await successStore.saveRun({
    tool: "badnews",
    name: "Bad.news 富文本回归",
    inputKind: "manual",
    sourceSummary: "测试",
    results: [
      {
        resultKey: "https://bad.news/t/123456",
        primaryValue: "https://bad.news/t/123456",
        secondaryValue: "",
        status: "success",
        tags: [],
        source: "telegram",
      },
      {
        resultKey: "https://bad.news/t/123457",
        primaryValue: "https://bad.news/t/123457",
        secondaryValue: "",
        status: "success",
        tags: [],
        source: "telegram",
      },
    ],
  });
  assert.ok(saved.runId);
  assert.equal(
    successDatabase
      .prepare("SELECT input_kind FROM content_runs WHERE id=?")
      .get(saved.runId).input_kind,
    "manual",
  );
  assert.equal(
    successDatabase
      .prepare("SELECT COUNT(*) AS count FROM content_results WHERE run_id=?")
      .get(saved.runId).count,
    2,
  );
  assert.equal(
    successDatabase
      .prepare(
        "SELECT COUNT(*) AS count FROM permanent_records WHERE tool='badnews'",
      )
      .get().count,
    2,
  );
  assert.equal(
    successDatabase
      .prepare("SELECT COUNT(*) AS count FROM task_inbox WHERE run_id=?")
      .get(saved.runId).count,
    1,
  );
  assert.equal(
    successDatabase
      .prepare("SELECT metadata_json FROM content_results WHERE run_id=?")
      .get(saved.runId)
      .metadata_json.includes("__runStage"),
    false,
  );
  const restoredOrder = await successStore.getRun(saved.runId, 1, 100);
  assert.deepEqual(
    restoredOrder.results.map((row) => row.primary_value),
    ["https://bad.news/t/123456", "https://bad.news/t/123457"],
  );
  successDatabase.close();

  const failedDatabase = new DatabaseSync(":memory:");
  await applySchema(failedDatabase);
  const failedD1 = new TestD1Database(failedDatabase);
  const originalBatch = failedD1.batch.bind(failedD1);
  failedD1.batch = async (statements) => {
    if (
      statements.some((statement) =>
        /INSERT INTO task_inbox/.test(statement.sql),
      )
    )
      throw new Error("synthetic final commit failure");
    return originalBatch(statements);
  };
  const failedStore = await loadStoreServer({ DB: failedD1 });
  await assert.rejects(
    () =>
      failedStore.saveRun({
        tool: "badnews",
        name: "必须整体回滚",
        inputKind: "manual",
        results: [
          {
            resultKey: "https://bad.news/t/999999",
            primaryValue: "https://bad.news/t/999999",
            secondaryValue: "",
            status: "success",
            tags: [],
            source: "telegram",
          },
        ],
      }),
    /synthetic final commit failure/,
  );
  assert.equal(
    failedDatabase.prepare("SELECT COUNT(*) AS count FROM content_runs").get()
      .count,
    0,
  );
  assert.equal(
    failedDatabase
      .prepare("SELECT COUNT(*) AS count FROM content_results")
      .get().count,
    0,
  );
  assert.equal(
    failedDatabase
      .prepare("SELECT COUNT(*) AS count FROM permanent_records")
      .get().count,
    0,
  );
  assert.equal(
    failedDatabase.prepare("SELECT COUNT(*) AS count FROM task_inbox").get()
      .count,
    0,
  );
  failedDatabase.close();

  delete globalThis.__TELEGRAM_TEST_ENV__;
});

test("旧任务状态可规范写入，并可用高影响操作恢复点还原", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const audit = await loadAuditServer({ DB: new TestD1Database(database) });
  const timestamp = "2026-08-12T00:00:00.000Z";
  database
    .prepare(
      "INSERT INTO task_inbox(id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "task-legacy",
      "missav",
      "website",
      "旧任务",
      "",
      "",
      "",
      '{"total":10,"success":4}',
      timestamp,
      timestamp,
    );
  const insertTask = database.prepare(
    "INSERT INTO task_inbox(id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  for (const [id, stage] of [
    ["received", "new"],
    ["filtered", "filtered"],
    ["website", "website"],
    ["review", "needs_review"],
    ["error", "failed"],
    ["completed", "done"],
  ]) {
    insertTask.run(
      `task-${id}`,
      "badnews",
      stage,
      `阶段 ${id}`,
      "",
      "",
      "",
      "{}",
      timestamp,
      timestamp,
    );
  }
  const phases = await audit.listTasks({ page: 1, pageSize: 50 });
  assert.deepEqual(phases.counts, {
    received: 1,
    filtered: 1,
    website: 2,
    review: 1,
    error: 1,
    completed: 1,
  });
  assert.deepEqual(
    (
      await audit.listTasks({ phase: "filtered", page: 1, pageSize: 20 })
    ).rows.map((row) => row.id),
    ["task-filtered"],
  );
  assert.deepEqual(
    (await audit.listTasks({ phase: "website", page: 1, pageSize: 20 })).rows
      .map((row) => row.id)
      .sort(),
    ["task-legacy", "task-website"],
  );

  const changed = await audit.updateTasks(["task-legacy"], "failed");
  assert.equal(changed.changed, 1);
  assert.ok(changed.snapshotId);
  assert.equal(
    database
      .prepare("SELECT stage FROM task_inbox WHERE id=?")
      .get("task-legacy").stage,
    "retry_waiting",
  );

  const restored = await audit.restoreSnapshot(changed.snapshotId);
  assert.equal(restored.restored, 1);
  assert.equal(
    database
      .prepare("SELECT stage FROM task_inbox WHERE id=?")
      .get("task-legacy").stage,
    "website",
  );
  assert.equal(
    database
      .prepare("SELECT status FROM data_snapshots WHERE id=?")
      .get(changed.snapshotId).status,
    "restored",
  );

  delete globalThis.__TELEGRAM_TEST_ENV__;
  database.close();
});

test(
  "1000 条单来源导入为一次服务端任务，D1 往返不产生逐消息 N+1，五工具任务按批次聚合",
  { timeout: 30_000 },
  async () => {
    const database = new DatabaseSync(":memory:");
    await applySchema(database);
    const d1 = new TestD1Database(database);
    const server = await loadTelegramServer({ DB: d1 });
    const base = {
      sourceKey: "-100-performance",
      sourceName: "性能频道",
      connectionId: "telegram-import",
      chatType: "channel",
      username: "performance",
      messageDate: "2026-08-14T00:00:00.000Z",
    };
    await server.importTelegramMessages([
      { ...base, messageId: "seed", text: "建立来源" },
    ]);
    const source = database
      .prepare("SELECT id FROM input_sources WHERE external_chat_id=?")
      .get(base.sourceKey);
    const insertBinding = database.prepare(
      "INSERT INTO tool_source_bindings(id,source_id,tool,history_mode,history_limit,history_from,bound_at_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    for (const tool of ["twitter", "badnews", "haijiao", "missav", "av123"])
      insertBinding.run(
        `binding-${tool}`,
        source.id,
        tool,
        "cached",
        0,
        "",
        "",
        base.messageDate,
      );
    d1.resetMetrics();
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      ...base,
      messageId: String(index + 1),
      text: `@creator_${index % 10} https://bad.news/t/${7000000 + index} ABF-${100 + (index % 900)}`,
    }));
    const started = performance.now();
    const imported = await server.importTelegramMessages(messages);
    const elapsedMs = performance.now() - started;
    assert.equal(imported.inserted, 1_000);
    assert.equal(imported.queues, 5_000);
    assert.equal(imported.taskCount, 5);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_messages WHERE source_id=?",
        )
        .get(source.id).count,
      1_001,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue")
        .get().count,
      5_000,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM task_inbox").get().count,
      5,
    );
    assert.ok(
      d1.metrics.requests < 200,
      `unexpected D1 request count ${JSON.stringify(d1.metrics)}`,
    );
    assert.ok(
      d1.metrics.requests < messages.length / 5,
      `D1 requests scale like N+1: ${JSON.stringify(d1.metrics)}`,
    );
    console.log(
      "PERF telegram_import_1000",
      JSON.stringify({
        elapsedMs,
        ...d1.metrics,
        queues: imported.queues,
        aggregateTasks: imported.taskCount,
      }),
    );

    d1.resetMetrics();
    const duplicate = await server.importTelegramMessages(messages);
    assert.equal(duplicate.inserted, 0);
    assert.equal(duplicate.duplicates, 1_000);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM telegram_tool_queue")
        .get().count,
      5_000,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM task_inbox").get().count,
      5,
    );
    assert.ok(
      d1.metrics.requests < 50,
      `duplicate import should reuse prefetched sets: ${JSON.stringify(d1.metrics)}`,
    );
    console.log("PERF telegram_duplicate_1000", JSON.stringify(d1.metrics));

    const queueIds = database
      .prepare(
        "SELECT id FROM telegram_tool_queue WHERE tool='badnews' ORDER BY id",
      )
      .all()
      .map((row) => row.id);
    d1.resetMetrics();
    const processStarted = performance.now();
    const processed = await server.processTelegramQueue({
      tool: "badnews",
      queueIds,
      deleteBody: true,
    });
    const processElapsedMs = performance.now() - processStarted;
    assert.equal(processed.selected, 1_000);
    assert.equal(processed.resultCount, 1_000);
    assert.ok(
      processed.timings.ruleMs <= 1_000,
      `rule stage ${processed.timings.ruleMs} ms`,
    );
    assert.ok(
      processElapsedMs <= 8_000,
      `cached filter+save ${processElapsedMs} ms`,
    );
    assert.notEqual(
      database
        .prepare("SELECT body FROM telegram_messages WHERE message_id='1'")
        .get().body,
      "",
      "other tool queues are still pending, so shared body must remain",
    );
    assert.match(
      await readFile(projectFile("lib/server-telegram.ts"), "utf8"),
      /NOT EXISTS \(SELECT 1 FROM telegram_tool_queue remaining/,
    );
    console.log(
      "PERF telegram_process_1000",
      JSON.stringify({
        processElapsedMs,
        ...processed.timings,
        d1: d1.metrics,
      }),
    );
    delete globalThis.__TELEGRAM_TEST_ENV__;
    database.close();
  },
);

test("Bot 多页拉取中途失败后从已提交 offset 继续，已入库页不重放", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const server = await loadTelegramServer({
    DB: new TestD1Database(database),
    TELEGRAM_BOT_TOKEN: "test-token-not-secret",
  });
  const originalFetch = globalThis.fetch;
  const requestedOffsets = [];
  let updateRequest = 0;
  const update = (id) => ({
    update_id: id,
    channel_post: {
      message_id: id,
      date: 1_786_665_600 + id,
      text: `https://bad.news/t/${8000000 + id}`,
      chat: { id: -100888, type: "channel", title: "Bot 性能频道" },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/getWebhookInfo"))
      return Response.json({ ok: true, result: { url: "" } });
    if (!url.pathname.endsWith("/getUpdates"))
      throw new Error(`unexpected Bot method ${url.pathname}`);
    requestedOffsets.push(Number(url.searchParams.get("offset") || 0));
    updateRequest += 1;
    if (updateRequest === 1)
      return Response.json({
        ok: true,
        result: Array.from({ length: 100 }, (_, index) => update(index + 1)),
      });
    if (updateRequest === 2) throw new Error("synthetic network interruption");
    return Response.json({ ok: true, result: [update(101)] });
  };
  try {
    await assert.rejects(
      () => server.pullTelegramBot(),
      /无法连接 Telegram Bot API/,
    );
    assert.equal(
      database
        .prepare(
          "SELECT next_update_offset FROM telegram_bot_state WHERE connection_id='telegram-bot'",
        )
        .get().next_update_offset,
      101,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM telegram_messages").get()
        .count,
      100,
    );
    const resumed = await server.pullTelegramBot();
    assert.equal(resumed.inserted, 1);
    assert.equal(resumed.nextOffset, 102);
    assert.deepEqual(requestedOffsets, [0, 101, 101]);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM telegram_messages").get()
        .count,
      101,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__TELEGRAM_TEST_ENV__;
    database.close();
  }
});

test("Bot 租约在消息写入后失效时保留去重数据但不推进 offset", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const server = await loadTelegramServer({
    DB: new TestD1Database(database),
    TELEGRAM_BOT_TOKEN: "test-token-not-secret",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
    if (url.pathname.endsWith("/getUpdates")) {
      return Response.json({ ok: true, result: [{
        update_id: 501,
        channel_post: { message_id: 10, date: 1_786_665_600, text: "https://bad.news/t/9999999", chat: { id: -100999, type: "channel", title: "租约测试" } },
      }] });
    }
    throw new Error(`unexpected Bot method ${url.pathname}`);
  };
  try {
    let leaseChecks = 0;
    await assert.rejects(
      () => server.pullTelegramBot(undefined, { assertRemoteLease: () => {
        leaseChecks += 1;
        if (leaseChecks < 2) return;
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM telegram_messages").get().count, 1);
        throw new Error("synthetic lease expired after message write");
      } }),
      /synthetic lease expired/,
    );
    assert.equal(leaseChecks, 2);
    assert.equal(database.prepare("SELECT next_update_offset FROM telegram_bot_state WHERE connection_id='telegram-bot'").get().next_update_offset, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM telegram_messages").get().count, 1);
    assert.equal(database.prepare("SELECT status FROM telegram_sync_runs ORDER BY started_at DESC LIMIT 1").get().status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__TELEGRAM_TEST_ENV__;
    database.close();
  }
});

test("个人 API 租约在最终提交前失效时不推进 checkpoint", async () => {
  const database = new DatabaseSync(":memory:");
  await applySchema(database);
  const d1 = new TestD1Database(database);
  const server = await loadServer("lib/telegram-sync-commit.ts", { DB: d1 });
  const timestamp = "2026-08-23T14:00:00.000Z";
  database.prepare(
    `INSERT INTO input_sources(id,kind,external_key,name,metadata_json,created_at,updated_at,connection_id,external_chat_id,incremental_checkpoint_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run("lease-personal-source", "telegram_personal", "-100700", "租约测试", "{}", timestamp, timestamp, "telegram-personal", "-100700", "100");
  const checkpointUpdate = d1.prepare("UPDATE input_sources SET incremental_checkpoint_id='200' WHERE id='lease-personal-source'");
  await assert.rejects(
    () => server.commitPersonalSyncCheckpoint([checkpointUpdate], () => { throw new Error("synthetic lease expired"); }),
    /synthetic lease expired/,
  );
  assert.equal(database.prepare("SELECT incremental_checkpoint_id FROM input_sources WHERE id='lease-personal-source'").get().incremental_checkpoint_id, "100");
  await server.commitPersonalSyncCheckpoint([checkpointUpdate], () => undefined);
  assert.equal(database.prepare("SELECT incremental_checkpoint_id FROM input_sources WHERE id='lease-personal-source'").get().incremental_checkpoint_id, "200");
  delete globalThis.__TELEGRAM_TEST_ENV__;
  database.close();
});

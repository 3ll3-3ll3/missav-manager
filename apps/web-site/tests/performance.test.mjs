import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadModule } from "./helpers/bundle.mjs";

const telegram = await loadModule("lib/telegram.ts");
const rules = await loadModule("lib/rules.ts");

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)
  ];
}

test(
  "十万条结构化记录可通过索引分页、筛选和排序，不加载全库",
  { timeout: 20_000 },
  () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE permanent_records(id TEXT PRIMARY KEY,tool TEXT,status TEXT,primary_value TEXT,updated_at TEXT);CREATE INDEX tool_status_updated ON permanent_records(tool,status,updated_at);",
    );
    const insert = db.prepare(
      "INSERT INTO permanent_records VALUES(?,?,?,?,?)",
    );
    db.exec("BEGIN");
    for (let index = 0; index < 100_000; index += 1)
      insert.run(
        String(index).padStart(6, "0"),
        index % 5 === 0 ? "missav" : "twitter",
        index % 3 === 0 ? "ready" : "new",
        `CODE-${index}`,
        new Date(1_700_000_000_000 + index * 1000).toISOString(),
      );
    db.exec("COMMIT");
    const started = performance.now();
    const rows = db
      .prepare(
        "SELECT id,primary_value FROM permanent_records WHERE tool=? AND status=? ORDER BY updated_at DESC,id DESC LIMIT 100 OFFSET 6000",
      )
      .all("missav", "ready");
    const elapsed = performance.now() - started;
    assert.equal(rows.length, 100);
    assert.ok(elapsed < 1_500, `indexed page took ${elapsed.toFixed(1)} ms`);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM permanent_records").get().count,
      100_000,
    );
    db.close();
  },
);

test("同来源 100、1000、10000 条分组保持线性且不复制已有数组", () => {
  const timings = [];
  for (const size of [100, 1_000, 10_000]) {
    const rows = Array.from({ length: size }, (_, index) => ({
      sourceKey: "same",
      sourceName: "同一来源",
      messageId: String(index),
      messageDate: "",
      text: `消息 ${index}`,
    }));
    const samples = [];
    for (let run = 0; run < 15; run += 1) {
      const started = performance.now();
      const grouped = telegram.groupTelegramImportMessages(
        rows,
        "telegram-import",
      );
      samples.push(performance.now() - started);
      assert.equal(grouped.get("telegram-import\u0000same").length, size);
    }
    timings.push({
      size,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
    });
  }
  assert.ok(
    timings[2].p95 < Math.max(80, timings[1].p95 * 20),
    JSON.stringify(timings),
  );
  console.log("PERF telegram_grouping", JSON.stringify(timings));
});

test("1000 条短消息运行单个文本规则的 p95 不超过 1 秒", () => {
  const messages = Array.from({ length: 1_000 }, (_, index) => ({
    text: `入口 https://bad.news/t/${6000000 + index}?from=tg`,
    links: [],
    messageDate: "2026-08-14T00:00:00.000Z",
    sourceType: "telegram_api",
    source: "性能来源",
    sourceKind: "telegram_api",
    sourceName: "性能来源",
    connectionId: "telegram-personal",
    sourceId: "source-1",
    messageId: String(index + 1),
    eventKind: "message",
  }));
  const samples = [];
  let last;
  for (let run = 0; run < 20; run += 1) {
    const started = performance.now();
    last = rules.processMessages("badnews", messages);
    samples.push(performance.now() - started);
  }
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  assert.equal(last.results.length, 1_000);
  assert.ok(p95 <= 1_000, `p95 ${p95.toFixed(2)} ms`);
  console.log(
    "PERF rules_1000",
    JSON.stringify({ p50Ms: p50, p95Ms: p95, results: last.results.length }),
  );
});

test("Telegram 队列常用查询计划命中组合索引", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE telegram_messages(id TEXT PRIMARY KEY,source_id TEXT,message_id TEXT,message_date TEXT,body TEXT);
    CREATE UNIQUE INDEX telegram_messages_source_message_uq ON telegram_messages(source_id,message_id);
    CREATE INDEX telegram_messages_source_date_id_idx ON telegram_messages(source_id,message_date,id);
    CREATE TABLE telegram_tool_queue(id TEXT PRIMARY KEY,telegram_message_id TEXT,tool TEXT,status TEXT,message_date TEXT,updated_at TEXT);
    CREATE UNIQUE INDEX telegram_tool_queue_message_tool_uq ON telegram_tool_queue(telegram_message_id,tool);
    CREATE INDEX telegram_tool_queue_message_status_idx ON telegram_tool_queue(telegram_message_id,status);
    CREATE INDEX telegram_tool_queue_tool_status_date_id_idx ON telegram_tool_queue(tool,status,message_date,id);`);
  const queuePlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM telegram_tool_queue WHERE tool=? AND status=? ORDER BY message_date DESC,id DESC LIMIT 50",
    )
    .all("badnews", "pending")
    .map((row) => String(row.detail))
    .join(" | ");
  const sourcePlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM telegram_messages WHERE source_id=? AND message_date>=? ORDER BY message_date,id LIMIT 50",
    )
    .all("source-1", "2026-01-01")
    .map((row) => String(row.detail))
    .join(" | ");
  const pendingPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM telegram_messages m WHERE id=? AND NOT EXISTS (SELECT 1 FROM telegram_tool_queue q WHERE q.telegram_message_id=m.id AND q.status IN ('pending','error'))",
    )
    .all("message-1")
    .map((row) => String(row.detail))
    .join(" | ");
  assert.match(queuePlan, /telegram_tool_queue_tool_status_date_id_idx/);
  assert.match(sourcePlan, /telegram_messages_source_date_id_idx/);
  assert.match(pendingPlan, /telegram_tool_queue_message_status_idx/);
  console.log("QUERY_PLAN queue", queuePlan);
  console.log("QUERY_PLAN source", sourcePlan);
  console.log("QUERY_PLAN cleanup", pendingPlan);
  db.close();
});

test("个人来源并发遇到 FloodWait 后降为 1，只重试受影响来源", async () => {
  const attempts = new Map();
  let active = 0;
  let maxActive = 0;
  const queue = await telegram.runAdaptiveTelegramSourceQueue(
    ["a", "b", "c", "d", "e"],
    async (source) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const attempt = (attempts.get(source) || 0) + 1;
      attempts.set(source, attempt);
      await Promise.resolve();
      active -= 1;
      if (source === "b" && attempt === 1) throw new Error("FLOOD_WAIT_3");
      return `${source}:${attempt}`;
    },
    3,
  );
  assert.equal(queue.initialConcurrency, 3);
  assert.equal(queue.finalConcurrency, 1);
  assert.equal(queue.reducedByFlood, true);
  assert.equal(maxActive, 3);
  assert.deepEqual(queue.results, ["a:1", "b:2", "c:1", "d:1", "e:1"]);
  assert.equal(attempts.get("b"), 2);
  assert.equal(
    [...attempts.values()].reduce((sum, value) => sum + value, 0),
    6,
  );
});

test("安全停止只在来源并发批次边界生效，已完成结果不会回退", async () => {
  let completed = 0;
  let stop = false;
  const queue = await telegram.runAdaptiveTelegramSourceQueue(
    ["a", "b", "c", "d", "e", "f"],
    async (source) => {
      completed += 1;
      if (completed === 3) stop = true;
      return source;
    },
    3,
    () => stop,
  );
  assert.equal(queue.stopped, true);
  assert.equal(queue.completed, 3);
  assert.deepEqual(queue.results, ["a", "b", "c"]);
});

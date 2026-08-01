import { env } from "cloudflare:workers";
import { getD1 } from "../db";
import { processDocuments } from "./rules";
import { writeLog } from "./server-audit";
import { ensureSchema, nowIso, saveRun } from "./server-store";
import { csvSafe, redact, safeJson } from "./security";
import { telegramBotUpdates, type TelegramImportMessage } from "./telegram";
import type { ToolId } from "./types";

const TOOLS = new Set(["twitter", "badnews", "haijiao", "missav", "av123"]);

function token() {
  return String(
    (env as unknown as Record<string, unknown>).TELEGRAM_BOT_TOKEN ?? "",
  ).trim();
}

function cleanTool(value: unknown) {
  const tool = String(value ?? "");
  if (!TOOLS.has(tool)) throw new Error("未知工具");
  return tool as ToolId;
}

async function sourceFor(kind: string, externalKey: string, name: string) {
  const existing = await getD1()
    .prepare("SELECT * FROM input_sources WHERE kind=? AND external_key=?")
    .bind(kind, externalKey)
    .first();
  const timestamp = nowIso();
  if (existing) {
    await getD1()
      .prepare("UPDATE input_sources SET name=?,updated_at=? WHERE id=?")
      .bind(name.slice(0, 240), timestamp, existing.id)
      .run();
    return String(existing.id);
  }
  const id = crypto.randomUUID();
  await getD1()
    .prepare(
      "INSERT INTO input_sources(id,kind,external_key,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      kind,
      externalKey.slice(0, 200),
      name.slice(0, 240),
      "{}",
      timestamp,
      timestamp,
    )
    .run();
  return id;
}

async function commitMessages(
  messages: TelegramImportMessage[],
  kind: "telegram_bot" | "telegram_import",
  nextOffset?: number,
) {
  await ensureSchema();
  const transactionId = crypto.randomUUID();
  const timestamp = nowIso();
  let inserted = 0;
  let duplicates = 0;
  let queues = 0;
  const grouped = new Map<string, TelegramImportMessage[]>();
  for (const message of messages) {
    const key = `${message.sourceKey}\u0000${message.sourceName}`;
    grouped.set(key, [...(grouped.get(key) ?? []), message]);
  }
  for (const [key, group] of grouped) {
    const [externalKey, sourceName] = key.split("\u0000");
    const sourceId = await sourceFor(kind, externalKey, sourceName);
    const bindings = await getD1()
      .prepare(
        "SELECT tool FROM tool_source_bindings WHERE source_id=? ORDER BY tool",
      )
      .bind(sourceId)
      .all();
    const tools = (bindings.results ?? [])
      .map((row) => String(row.tool))
      .filter((tool) => TOOLS.has(tool));
    for (const message of group) {
      const exists = await getD1()
        .prepare(
          "SELECT id FROM telegram_message_fingerprints WHERE source_id=? AND message_id=?",
        )
        .bind(sourceId, message.messageId)
        .first();
      if (exists) {
        duplicates += 1;
        continue;
      }
      const messageRowId = crypto.randomUUID();
      const statements = [
        getD1()
          .prepare(
            "INSERT INTO telegram_message_fingerprints(id,source_id,message_id,created_at) VALUES (?,?,?,?)",
          )
          .bind(crypto.randomUUID(), sourceId, message.messageId, timestamp),
        getD1()
          .prepare(
            `INSERT INTO telegram_messages(id,source_id,message_id,message_date,body,body_deleted_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`,
          )
          .bind(
            messageRowId,
            sourceId,
            message.messageId,
            message.messageDate.slice(0, 40),
            message.text.slice(0, 100_000),
            "",
            timestamp,
            timestamp,
          ),
        ...tools.flatMap((tool) => {
          const queueId = crypto.randomUUID();
          return [
            getD1()
              .prepare(
                `INSERT INTO telegram_tool_queue(id,telegram_message_id,tool,status,candidate_count,run_id,processed_at,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                queueId,
                messageRowId,
                tool,
                "pending",
                0,
                "",
                "",
                timestamp,
                timestamp,
              ),
            getD1()
              .prepare(
                `INSERT INTO task_inbox(id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                crypto.randomUUID(),
                tool,
                "new",
                `${sourceName} · 消息 ${message.messageId}`,
                "",
                queueId,
                sourceId,
                safeJson({ messageId: message.messageId }, {}),
                timestamp,
                timestamp,
              ),
          ];
        }),
      ];
      await getD1().batch(statements);
      inserted += 1;
      queues += tools.length;
    }
  }
  const finalStatements = [
    getD1()
      .prepare(
        `INSERT INTO sync_transactions
    (id,source_kind,status,received_count,inserted_count,duplicate_count,queue_count,detail_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        transactionId,
        kind,
        "completed",
        messages.length,
        inserted,
        duplicates,
        queues,
        safeJson({ sourceCount: grouped.size }, {}),
        timestamp,
        timestamp,
      ),
  ];
  if (kind === "telegram_bot" && Number.isFinite(nextOffset)) {
    finalStatements.push(
      getD1()
        .prepare(
          `INSERT INTO app_settings(key,value_json,updated_at) VALUES ('telegramBotOffset',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
        )
        .bind(JSON.stringify(nextOffset), timestamp),
    );
  }
  await getD1().batch(finalStatements);
  await writeLog("info", "telegram", "Telegram 消息已安全分发", {
    kind,
    received: messages.length,
    inserted,
    duplicates,
    queues,
    transactionId,
  });
  return {
    transactionId,
    received: messages.length,
    inserted,
    duplicates,
    queues,
  };
}

export async function telegramStatus() {
  await ensureSchema();
  const [sources, bindings, syncs] = await getD1().batch([
    getD1()
      .prepare(`SELECT s.*,COUNT(DISTINCT m.id) AS message_count FROM input_sources s LEFT JOIN telegram_messages m ON m.source_id=s.id
      GROUP BY s.id ORDER BY s.updated_at DESC`),
    getD1().prepare(
      "SELECT source_id,tool FROM tool_source_bindings ORDER BY source_id,tool",
    ),
    getD1().prepare(
      "SELECT * FROM sync_transactions ORDER BY created_at DESC LIMIT 10",
    ),
  ]);
  return {
    configured: Boolean(token()),
    sources: sources.results ?? [],
    bindings: bindings.results ?? [],
    syncs: syncs.results ?? [],
  };
}

export async function pullTelegramBot() {
  await ensureSchema();
  const secret = token();
  if (!secret)
    throw new Error(
      "Telegram Bot 尚未配置；请先在 Site Secrets 设置 TELEGRAM_BOT_TOKEN。",
    );
  const row = await getD1()
    .prepare(
      "SELECT value_json FROM app_settings WHERE key='telegramBotOffset'",
    )
    .first();
  const offset =
    Number(row?.value_json ? JSON.parse(String(row.value_json)) : 0) || 0;
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${secret}/getUpdates?offset=${offset}&limit=15&timeout=0`,
      { method: "GET" },
    );
  } catch (error) {
    await writeLog("error", "telegram", "Telegram Bot 网络请求失败", {
      error: redact(error),
    });
    throw new Error(
      "无法连接 Telegram Bot API；请稍后重试并检查 Site Secret。",
    );
  }
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    !payload ||
    (payload as Record<string, unknown>).ok !== true
  ) {
    await writeLog("error", "telegram", "Telegram Bot API 返回失败", {
      status: response.status,
      description: redact(
        (payload as Record<string, unknown> | null)?.description,
      ),
    });
    throw new Error(
      response.status === 401
        ? "Telegram Bot Token 无效，请在 Site Secrets 更新后重试。"
        : "Telegram Bot API 暂时不可用。",
    );
  }
  const parsed = telegramBotUpdates(payload);
  return commitMessages(
    parsed.messages,
    "telegram_bot",
    parsed.nextOffset || offset,
  );
}

export async function importTelegramMessages(
  messages: TelegramImportMessage[],
) {
  const safe = messages
    .slice(0, 100_000)
    .map((message) => ({
      sourceKey: String(message.sourceKey).slice(0, 200),
      sourceName: String(message.sourceName).slice(0, 240),
      messageId: String(message.messageId).slice(0, 100),
      messageDate: String(message.messageDate).slice(0, 40),
      text: String(message.text).slice(0, 100_000),
    }))
    .filter((message) => message.sourceKey && message.messageId);
  let totals = { received: 0, inserted: 0, duplicates: 0, queues: 0 };
  for (let offset = 0; offset < safe.length; offset += 10) {
    const result = await commitMessages(
      safe.slice(offset, offset + 10),
      "telegram_import",
    );
    totals = {
      received: totals.received + result.received,
      inserted: totals.inserted + result.inserted,
      duplicates: totals.duplicates + result.duplicates,
      queues: totals.queues + result.queues,
    };
  }
  return totals;
}

export async function bindTelegramSource(input: {
  sourceId: string;
  tool: string;
  enabled: boolean;
}) {
  await ensureSchema();
  const tool = cleanTool(input.tool);
  const sourceId = String(input.sourceId || "");
  const timestamp = nowIso();
  if (!sourceId) throw new Error("缺少 Telegram 来源");
  if (!input.enabled) {
    await getD1()
      .prepare("DELETE FROM tool_source_bindings WHERE source_id=? AND tool=?")
      .bind(sourceId, tool)
      .run();
    return { enabled: false };
  }
  await getD1()
    .prepare(
      "INSERT OR IGNORE INTO tool_source_bindings(id,source_id,tool,created_at) VALUES (?,?,?,?)",
    )
    .bind(crypto.randomUUID(), sourceId, tool, timestamp)
    .run();
  let cursor = "";
  while (true) {
    const rows = await getD1()
      .prepare(
        "SELECT id,message_id FROM telegram_messages WHERE source_id=? AND id>? ORDER BY id LIMIT 80",
      )
      .bind(sourceId, cursor)
      .all();
    const chunk = rows.results ?? [];
    if (!chunk.length) break;
    const existing = await getD1()
      .prepare(
        `SELECT telegram_message_id FROM telegram_tool_queue WHERE tool=? AND telegram_message_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(tool, ...chunk.map((row: Record<string, unknown>) => row.id))
      .all();
    const queued = new Set(
      (existing.results ?? []).map((row: Record<string, unknown>) =>
        String(row.telegram_message_id),
      ),
    );
    const missing = chunk.filter(
      (row: Record<string, unknown>) => !queued.has(String(row.id)),
    );
    if (missing.length)
      await getD1().batch(
        missing.flatMap((row: Record<string, unknown>) => {
          const queueId = crypto.randomUUID();
          return [
            getD1()
              .prepare(
                `INSERT INTO telegram_tool_queue(id,telegram_message_id,tool,status,candidate_count,run_id,processed_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                queueId,
                row.id,
                tool,
                "pending",
                0,
                "",
                "",
                timestamp,
                timestamp,
              ),
            getD1()
              .prepare(
                `INSERT INTO task_inbox(id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                crypto.randomUUID(),
                tool,
                "new",
                `Telegram 消息 ${String(row.message_id)}`,
                "",
                queueId,
                sourceId,
                "{}",
                timestamp,
                timestamp,
              ),
          ];
        }),
      );
    cursor = String(chunk.at(-1)?.id ?? "");
    if (chunk.length < 80) break;
  }
  return { enabled: true };
}

type QueueFilters = {
  tool: string;
  status?: string;
  search?: string;
  start?: string;
  end?: string;
};
function queueFilter(input: QueueFilters) {
  const tool = cleanTool(input.tool);
  const clauses = ["q.tool=?"];
  const values: unknown[] = [tool];
  if (input.status) {
    clauses.push("q.status=?");
    values.push(String(input.status).slice(0, 32));
  }
  if (input.search?.trim()) {
    clauses.push("(m.body LIKE ? OR s.name LIKE ? OR m.message_id LIKE ?)");
    const like = `%${input.search.trim().slice(0, 160)}%`;
    values.push(like, like, like);
  }
  if (input.start) {
    clauses.push("m.message_date>=?");
    values.push(String(input.start).slice(0, 40));
  }
  if (input.end) {
    clauses.push("m.message_date<=?");
    values.push(String(input.end).slice(0, 40));
  }
  return {
    tool,
    where: ` WHERE ${clauses.join(" AND ")}`,
    values,
    from: " FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id",
  };
}

export async function listTelegramQueue(input: {
  tool: string;
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  start?: string;
  end?: string;
}) {
  await ensureSchema();
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(20, Math.trunc(Number(input.pageSize) || 50)),
  );
  const { where, from, values } = queueFilter(input);
  const [count, rows] = await getD1().batch([
    getD1()
      .prepare(`SELECT COUNT(*) AS count${from}${where}`)
      .bind(...values),
    getD1()
      .prepare(
        `SELECT q.*,m.message_id,m.message_date,m.body,m.body_deleted_at,s.id AS source_id,s.name AS source_name${from}${where} ORDER BY m.message_date DESC,m.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, pageSize, (page - 1) * pageSize),
  ]);
  return {
    rows: rows.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function resolveTelegramQueueSelection(input: {
  tool: string;
  mode?: "ids" | "all";
  queueIds?: string[];
  excludeIds?: string[];
  status?: string;
  search?: string;
  start?: string;
  end?: string;
}) {
  if (input.mode !== "all")
    return [...new Set((input.queueIds ?? []).map(String).filter(Boolean))];
  const query = queueFilter(input);
  const excluded = new Set((input.excludeIds ?? []).map(String));
  const ids: string[] = [];
  let cursor = "";
  while (true) {
    const cursorSql = `${query.where} AND q.id>?`;
    const rows = await getD1()
      .prepare(`SELECT q.id${query.from}${cursorSql} ORDER BY q.id LIMIT 5000`)
      .bind(...query.values, cursor)
      .all();
    const chunk = (rows.results ?? []).map((row: Record<string, unknown>) =>
      String(row.id),
    );
    ids.push(...chunk.filter((id) => !excluded.has(id)));
    if (chunk.length < 5000) break;
    cursor = chunk.at(-1) || "";
  }
  if (ids.length > 10_000)
    throw new Error(
      "当前 Telegram 操作范围超过 10,000 条，请先增加状态、关键词或时间筛选。 ",
    );
  return ids;
}

export async function processTelegramQueue(input: {
  tool: string;
  queueIds: string[];
  deleteBody?: boolean;
}) {
  await ensureSchema();
  const tool = cleanTool(input.tool);
  const ids = [...new Set((input.queueIds ?? []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("请先选择 Telegram 消息");
  if (ids.length > 10_000)
    throw new Error("单次 Telegram 处理最多 10,000 条，请缩小筛选范围。 ");
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT q.id,q.telegram_message_id,m.body,m.message_id,m.message_date,s.name AS source_name
      FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id
      WHERE q.tool=? AND q.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(tool, ...chunk)
      .all();
    rows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  const allResults = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const output = processDocuments(tool, [
      {
        name: `${String(row.source_name)}#${String(row.message_id)}`,
        text: String(row.body ?? ""),
      },
    ]);
    counts.set(String(row.id), output.results.length);
    allResults.push(...output.results);
  }
  let runId = "";
  if (allResults.length) {
    const saved = await saveRun({
      tool,
      name: `Telegram · ${new Date().toLocaleString("zh-CN")}`,
      inputKind: "telegram_queue",
      sourceSummary: `${rows.length} 条所选消息`,
      results: allResults,
    });
    runId = saved.runId;
  }
  const timestamp = nowIso();
  await getD1().batch(
    rows.map((row) => {
      const count = counts.get(String(row.id)) ?? 0;
      return getD1()
        .prepare(
          "UPDATE telegram_tool_queue SET status=?,candidate_count=?,run_id=?,processed_at=?,updated_at=? WHERE id=?",
        )
        .bind(
          count ? "processed" : "processed_empty",
          count,
          runId,
          timestamp,
          timestamp,
          row.id,
        );
    }),
  );
  if (input.deleteBody !== false) {
    for (const messageId of new Set(
      rows.map((row) => String(row.telegram_message_id)),
    )) {
      const pending = await getD1()
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_tool_queue WHERE telegram_message_id=? AND status IN ('pending','error')",
        )
        .bind(messageId)
        .first();
      if (Number(pending?.count ?? 0) === 0)
        await getD1()
          .prepare(
            "UPDATE telegram_messages SET body='',body_deleted_at=?,updated_at=? WHERE id=?",
          )
          .bind(timestamp, timestamp, messageId)
          .run();
    }
  }
  await writeLog("info", "telegram", "已处理所选 Telegram 消息", {
    tool,
    selected: rows.length,
    resultCount: allResults.length,
    runId,
  });
  return { selected: rows.length, resultCount: allResults.length, runId };
}

export async function updateTelegramQueue(
  ids: string[],
  status: "pending" | "ignored",
) {
  if (!new Set(["pending", "ignored"]).has(status))
    throw new Error("消息状态无效");
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (unique.length > 10_000)
    throw new Error("单次 Telegram 状态修改最多 10,000 条，请缩小筛选范围。 ");
  let changed = 0;
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `UPDATE telegram_tool_queue SET status=?,updated_at=? WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(status, nowIso(), ...chunk)
      .run();
    changed += Number(result.meta?.changes ?? 0);
  }
  return { changed };
}

export async function exportTelegramQueue(
  ids: string[],
  format: "txt" | "csv",
) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (unique.length > 10_000)
    throw new Error("单次 Telegram 原文导出最多 10,000 条，请缩小筛选范围。 ");
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `SELECT q.id,q.status,m.message_id,m.message_date,m.body,s.name AS source_name FROM telegram_tool_queue q JOIN telegram_messages m ON m.id=q.telegram_message_id JOIN input_sources s ON s.id=m.source_id WHERE q.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all();
    rows.push(...((result.results ?? []) as Array<Record<string, unknown>>));
  }
  const order = new Map(unique.map((id, index) => [id, index]));
  rows.sort(
    (a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
  );
  if (format === "txt")
    return rows.map((row) => String(row.body ?? "")).join("\r\n\r\n");
  return `\uFEFF${[["message_id", "date", "source", "status", "body"].map(csvSafe).join(","), ...rows.map((row) => [row.message_id, row.message_date, row.source_name, row.status, row.body].map(csvSafe).join(","))].join("\r\n")}`;
}

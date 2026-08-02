import { getD1 } from "../db";
import { buildRaindropExport } from "./missav";
import { csvSafe, safeHttpUrl, safeJson, sha256Hex } from "./security";
import {
  createRecordSnapshot,
  createRunSnapshot,
  createSettingsSnapshot,
  writeLog,
} from "./server-audit";
import type {
  RecordFilters,
  RecordRow,
  SanitizedImportRecord,
  ToolResult,
} from "./types";
import defaultReferenceTagsRaw from "../public/default-reference-tags.txt?raw";

const TOOLS = new Set(["twitter", "badnews", "haijiao", "missav", "av123"]);
const EDITABLE_FIELDS: Record<string, string> = {
  primaryValue: "primary_value",
  secondaryValue: "secondary_value",
  status: "status",
  tags: "tags_json",
  actressTags: "actress_tags_json",
  genreTags: "genre_tags_json",
  sourceUrl: "source_url",
  missavUrl: "missav_url",
  av123Url: "av123_url",
  metadata: "metadata_json",
};
const SORT_FIELDS: Record<string, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  primaryValue: "primary_value",
  status: "status",
  tool: "tool",
};

let schemaReady: Promise<void> | null = null;

export function nowIso() {
  return new Date().toISOString();
}

function json(value: unknown, fallback: unknown) {
  return safeJson(value, fallback);
}

function parsed<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

function cleanTool(value: unknown) {
  const tool = String(value ?? "");
  if (!TOOLS.has(tool)) throw new Error("未知工具");
  return tool;
}

export async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getD1();
    const statements = [
      `CREATE TABLE IF NOT EXISTS content_runs (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, name TEXT NOT NULL, input_kind TEXT NOT NULL,
        start_at TEXT NOT NULL DEFAULT '', end_at TEXT NOT NULL DEFAULT '', source_summary TEXT NOT NULL DEFAULT '',
        total_count INTEGER NOT NULL DEFAULT 0, result_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS content_runs_tool_created_idx ON content_runs(tool, created_at)`,
      `CREATE TABLE IF NOT EXISTS content_results (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES content_runs(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, result_key TEXT NOT NULL, primary_value TEXT NOT NULL, secondary_value TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'success', tags_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(run_id, result_key)
      )`,
      `CREATE INDEX IF NOT EXISTS content_results_run_idx ON content_results(run_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS permanent_records (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, record_key TEXT NOT NULL, primary_value TEXT NOT NULL,
        secondary_value TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', tags_json TEXT NOT NULL DEFAULT '[]',
        actress_tags_json TEXT NOT NULL DEFAULT '[]', genre_tags_json TEXT NOT NULL DEFAULT '[]', source_url TEXT NOT NULL DEFAULT '',
        missav_url TEXT NOT NULL DEFAULT '', av123_url TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tool, record_key)
      )`,
      `CREATE INDEX IF NOT EXISTS permanent_records_tool_status_idx ON permanent_records(tool, status, updated_at)`,
      `CREATE INDEX IF NOT EXISTS permanent_records_updated_idx ON permanent_records(updated_at)`,
      `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, checksum TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        total_rows INTEGER NOT NULL DEFAULT 0, valid_rows INTEGER NOT NULL DEFAULT 0, rejected_rows INTEGER NOT NULL DEFAULT 0,
        applied_rows INTEGER NOT NULL DEFAULT 0, counts_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS import_batches_created_idx ON import_batches(created_at)`,
      `CREATE TABLE IF NOT EXISTS import_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, record_key TEXT NOT NULL, action TEXT NOT NULL, previous_json TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE(batch_id, tool, record_key)
      )`,
      `CREATE INDEX IF NOT EXISTS import_changes_batch_idx ON import_changes(batch_id, id)`,
      `CREATE TABLE IF NOT EXISTS import_batch_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL, checksum TEXT NOT NULL, row_count INTEGER NOT NULL, applied_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, UNIQUE(batch_id, chunk_index)
      )`,
      `CREATE INDEX IF NOT EXISTS import_batch_chunks_batch_idx ON import_batch_chunks(batch_id, id)`,
      `CREATE TABLE IF NOT EXISTS input_sources (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, external_key TEXT NOT NULL, name TEXT NOT NULL,
        connection_id TEXT NOT NULL DEFAULT '', external_chat_id TEXT NOT NULL DEFAULT '',
        chat_type TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
        access_status TEXT NOT NULL DEFAULT 'unknown', archived INTEGER NOT NULL DEFAULT 0,
        last_sync_at TEXT NOT NULL DEFAULT '', latest_remote_message_id TEXT NOT NULL DEFAULT '',
        incremental_checkpoint_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(kind, external_key)
      )`,
      `CREATE TABLE IF NOT EXISTS tool_source_bindings (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, history_mode TEXT NOT NULL DEFAULT 'since_now', history_limit INTEGER NOT NULL DEFAULT 0,
        history_from TEXT NOT NULL DEFAULT '', bound_at_message_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, UNIQUE(source_id, tool)
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_messages (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, connection_id TEXT NOT NULL DEFAULT '', external_message_id TEXT NOT NULL DEFAULT '',
        remote_update_id TEXT NOT NULL DEFAULT '', message_date TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        body_deleted_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(source_id, message_id)
      )`,
      `CREATE INDEX IF NOT EXISTS telegram_messages_date_idx ON telegram_messages(message_date, id)`,
      `CREATE TABLE IF NOT EXISTS telegram_tool_queue (
        id TEXT PRIMARY KEY, telegram_message_id TEXT NOT NULL REFERENCES telegram_messages(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', candidate_count INTEGER NOT NULL DEFAULT 0,
        run_id TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '', selected_at TEXT NOT NULL DEFAULT '',
        processing_at TEXT NOT NULL DEFAULT '', processed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(telegram_message_id, tool)
      )`,
      `CREATE INDEX IF NOT EXISTS telegram_tool_queue_tool_status_idx ON telegram_tool_queue(tool, status, updated_at)`,
      `CREATE TABLE IF NOT EXISTS telegram_message_fingerprints (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_id, message_id)
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_accounts (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'authorized', encrypted_session TEXT NOT NULL,
        account_key TEXT NOT NULL DEFAULT '', account_label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_connections (
        connection_id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'disconnected', account_key TEXT NOT NULL DEFAULT '',
        account_label TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', session_encrypted TEXT NOT NULL DEFAULT '',
        network_status TEXT NOT NULL DEFAULT 'unknown', last_connected_at TEXT NOT NULL DEFAULT '',
        last_success_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS telegram_connections_kind_idx ON telegram_connections(kind, status)`,
      `CREATE TABLE IF NOT EXISTS telegram_bot_state (
        connection_id TEXT PRIMARY KEY REFERENCES telegram_connections(connection_id) ON DELETE CASCADE,
        next_update_offset INTEGER NOT NULL DEFAULT 0, last_update_id INTEGER NOT NULL DEFAULT 0,
        lock_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_read_states (
        source_id TEXT PRIMARY KEY REFERENCES input_sources(id) ON DELETE CASCADE,
        policy TEXT NOT NULL DEFAULT 'never', safe_read_message_id TEXT NOT NULL DEFAULT '',
        last_marked_read_message_id TEXT NOT NULL DEFAULT '', read_baseline_message_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_sync_runs (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', transport TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'incremental', status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL DEFAULT '', scanned_count INTEGER NOT NULL DEFAULT 0, inserted_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0, queue_count INTEGER NOT NULL DEFAULT 0,
        empty_candidate_count INTEGER NOT NULL DEFAULT 0, checkpoint_before TEXT NOT NULL DEFAULT '',
        checkpoint_after TEXT NOT NULL DEFAULT '', read_result TEXT NOT NULL DEFAULT 'not_attempted',
        error_message TEXT NOT NULL DEFAULT '', detail_json TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX IF NOT EXISTS telegram_sync_runs_created_idx ON telegram_sync_runs(started_at, connection_id)`,
      `CREATE TABLE IF NOT EXISTS telegram_migration_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'preview', snapshot_id TEXT NOT NULL DEFAULT '',
        counts_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_auth_flows (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, stage TEXT NOT NULL, encrypted_session TEXT NOT NULL,
        challenge_json TEXT NOT NULL DEFAULT '{}', expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS telegram_auth_flows_expires_idx ON telegram_auth_flows(expires_at)`,
      `CREATE TABLE IF NOT EXISTS sync_transactions (
        id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, status TEXT NOT NULL, received_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0, duplicate_count INTEGER NOT NULL DEFAULT 0, queue_count INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS sync_transactions_created_idx ON sync_transactions(created_at)`,
      `CREATE TABLE IF NOT EXISTS task_inbox (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, stage TEXT NOT NULL, title TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '',
        record_id TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS task_inbox_stage_updated_idx ON task_inbox(stage, updated_at)`,
      `CREATE TABLE IF NOT EXISTS script_generations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL DEFAULT '', template_hash TEXT NOT NULL, code_count INTEGER NOT NULL,
        reference_tag_count INTEGER NOT NULL, reference_blacklist_count INTEGER NOT NULL, export_blacklist_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS script_generations_created_idx ON script_generations(created_at)`,
      `CREATE TABLE IF NOT EXISTS app_logs (
        id TEXT PRIMARY KEY, level TEXT NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS app_logs_level_created_idx ON app_logs(level, created_at)`,
      `CREATE TABLE IF NOT EXISTS data_snapshots (
        id TEXT PRIMARY KEY, reason TEXT NOT NULL, entity TEXT NOT NULL, item_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL, restored_at TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE INDEX IF NOT EXISTS data_snapshots_created_idx ON data_snapshots(created_at)`,
      `CREATE TABLE IF NOT EXISTS data_snapshot_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id) ON DELETE CASCADE,
        entity_key TEXT NOT NULL, previous_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS data_snapshot_items_snapshot_idx ON data_snapshot_items(snapshot_id, id)`,
    ];
    await db.batch(statements.map((statement) => db.prepare(statement)));
    // The private Site has already been deployed with the pre-hub schema. D1
    // migrations are checked in as well, but this bounded compatibility step
    // lets an existing database adopt the new columns before the next request.
    const columns: Array<[string, string]> = [
      ["input_sources", "connection_id TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "external_chat_id TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "chat_type TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "username TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "access_status TEXT NOT NULL DEFAULT 'unknown'"],
      ["input_sources", "archived INTEGER NOT NULL DEFAULT 0"],
      ["input_sources", "last_sync_at TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "latest_remote_message_id TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "incremental_checkpoint_id TEXT NOT NULL DEFAULT ''"],
      ["input_sources", "last_error TEXT NOT NULL DEFAULT ''"],
      ["tool_source_bindings", "history_mode TEXT NOT NULL DEFAULT 'since_now'"],
      ["tool_source_bindings", "history_limit INTEGER NOT NULL DEFAULT 0"],
      ["tool_source_bindings", "history_from TEXT NOT NULL DEFAULT ''"],
      ["tool_source_bindings", "bound_at_message_id TEXT NOT NULL DEFAULT ''"],
      ["telegram_messages", "connection_id TEXT NOT NULL DEFAULT ''"],
      ["telegram_messages", "external_message_id TEXT NOT NULL DEFAULT ''"],
      ["telegram_messages", "remote_update_id TEXT NOT NULL DEFAULT ''"],
      ["telegram_tool_queue", "error_message TEXT NOT NULL DEFAULT ''"],
      ["telegram_tool_queue", "selected_at TEXT NOT NULL DEFAULT ''"],
      ["telegram_tool_queue", "processing_at TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [table, definition] of columns) {
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
      } catch (error) {
        if (!/duplicate column|already exists/i.test(String(error))) throw error;
      }
    }
    await db.batch([
      db.prepare("UPDATE input_sources SET connection_id=CASE WHEN kind='telegram_bot' THEN 'telegram-bot' WHEN kind='telegram_personal' THEN 'telegram-personal' ELSE 'legacy-' || kind END WHERE connection_id=''"),
      db.prepare("UPDATE input_sources SET external_chat_id=external_key WHERE external_chat_id=''"),
      db.prepare("UPDATE telegram_messages SET connection_id=(SELECT connection_id FROM input_sources WHERE input_sources.id=telegram_messages.source_id), external_message_id=message_id WHERE external_message_id=''"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS input_sources_connection_chat_uq ON input_sources(connection_id, external_chat_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS input_sources_connection_status_idx ON input_sources(connection_id, access_status, updated_at)"),
      db.prepare("INSERT OR IGNORE INTO telegram_connections(connection_id,kind,label,status,account_key,account_label,username,session_encrypted,network_status,last_connected_at,last_success_at,last_error,created_at,updated_at) SELECT 'telegram-personal','personal','Telegram 个人账号',status,account_key,account_label,'',encrypted_session,'unknown','',updated_at,'',created_at,updated_at FROM telegram_accounts"),
      db.prepare("INSERT OR IGNORE INTO telegram_connections(connection_id,kind,label,status,created_at,updated_at) VALUES ('telegram-bot','bot','Telegram Bot','disconnected',datetime('now'),datetime('now'))"),
    ]);
    const legacyOffsetRow = await db.prepare("SELECT value_json FROM app_settings WHERE key='telegramBotOffset'").first<{ value_json: string }>();
    if (legacyOffsetRow) {
      let legacyOffset = 0;
      try { legacyOffset = Math.max(0, Number(JSON.parse(legacyOffsetRow.value_json)) || 0); } catch { legacyOffset = 0; }
      if (legacyOffset > 0) {
        await db.prepare("UPDATE telegram_bot_state SET next_update_offset=MAX(next_update_offset,?),last_update_id=MAX(last_update_id,?),updated_at=? WHERE connection_id='telegram-bot'").bind(legacyOffset, legacyOffset - 1, nowIso()).run();
      }
    }
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export function recordFromRow(row: Record<string, unknown>): RecordRow {
  return {
    id: String(row.id),
    tool: String(row.tool) as RecordRow["tool"],
    recordKey: String(row.record_key),
    primaryValue: String(row.primary_value),
    secondaryValue: String(row.secondary_value ?? ""),
    status: String(row.status ?? "new"),
    tags: parsed<string[]>(row.tags_json, []),
    actressTags: parsed<string[]>(row.actress_tags_json, []),
    genreTags: parsed<string[]>(row.genre_tags_json, []),
    sourceUrl: String(row.source_url ?? ""),
    missavUrl: String(row.missav_url ?? ""),
    av123Url: String(row.av123_url ?? ""),
    metadata: parsed<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function filterSql(filters: RecordFilters, prefix = "") {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const column = (name: string) => `${prefix}${name}`;
  if (filters.tool) {
    cleanTool(filters.tool);
    clauses.push(`${column("tool")} = ?`);
    values.push(filters.tool);
  }
  if (filters.status) {
    clauses.push(`${column("status")} = ?`);
    values.push(String(filters.status).slice(0, 64));
  }
  const search = String(filters.search ?? "")
    .trim()
    .slice(0, 240);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(
      `(${column("record_key")} LIKE ? ESCAPE '\\' OR ${column("primary_value")} LIKE ? ESCAPE '\\' OR ${column("secondary_value")} LIKE ? ESCAPE '\\' OR ${column("tags_json")} LIKE ? ESCAPE '\\' OR ${column("actress_tags_json")} LIKE ? ESCAPE '\\' OR ${column("genre_tags_json")} LIKE ? ESCAPE '\\')`,
    );
    values.push(like, like, like, like, like, like);
  }
  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

async function recordIdsForFilters(filters: RecordFilters) {
  const query = filterSql(filters);
  const ids: string[] = [];
  let cursor = "";
  while (true) {
    const cursorClause = `${query.where ? " AND" : " WHERE"} id>?`;
    const rows = await getD1()
      .prepare(
        `SELECT id FROM permanent_records${query.where}${cursorClause} ORDER BY id LIMIT 5000`,
      )
      .bind(...query.values, cursor)
      .all();
    const chunk = (rows.results ?? []).map((row) => String(row.id));
    ids.push(...chunk);
    if (chunk.length < 5000) break;
    cursor = chunk.at(-1) || "";
  }
  return ids;
}

async function recordRowsForIds(ids: string[]) {
  const output: RecordRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const rows = await getD1()
      .prepare(
        `SELECT * FROM permanent_records WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all();
    output.push(
      ...(rows.results ?? []).map((row) =>
        recordFromRow(row as Record<string, unknown>),
      ),
    );
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  return output.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function dashboardSummary() {
  await ensureSchema();
  const db = getD1();
  const [records, runs, migrations] = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM permanent_records"),
    db.prepare("SELECT COUNT(*) AS count FROM content_runs"),
    db.prepare(
      "SELECT COUNT(*) AS count FROM import_batches WHERE status='applied'",
    ),
  ]);
  return {
    records: Number(records.results?.[0]?.count ?? 0),
    runs: Number(runs.results?.[0]?.count ?? 0),
    migrations: Number(migrations.results?.[0]?.count ?? 0),
  };
}

export async function saveRun(input: {
  tool: string;
  name: string;
  inputKind: string;
  startAt?: string;
  endAt?: string;
  sourceSummary?: string;
  results: ToolResult[];
}) {
  await ensureSchema();
  const db = getD1();
  const tool = cleanTool(input.tool);
  const name = String(input.name ?? "")
    .trim()
    .slice(0, 160);
  if (!name) throw new Error("历史名称不能为空");
  const results = Array.isArray(input.results)
    ? input.results.slice(0, 100_000)
    : [];
  const runId = crypto.randomUUID();
  const timestamp = nowIso();
  const unique = new Map<string, ToolResult>();
  for (const item of results) {
    const key = String(item.resultKey ?? "")
      .trim()
      .slice(0, 300);
    const primary = String(item.primaryValue ?? "")
      .trim()
      .slice(0, 1000);
    if (!key || !primary || unique.has(key.toLowerCase())) continue;
    unique.set(key.toLowerCase(), {
      ...item,
      resultKey: key,
      primaryValue: primary,
    });
  }
  await db
    .prepare(
      `INSERT INTO content_runs
    (id,tool,name,input_kind,start_at,end_at,source_summary,total_count,result_count,error_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      runId,
      tool,
      name,
      String(input.inputKind ?? "manual").slice(0, 60),
      String(input.startAt ?? "").slice(0, 40),
      String(input.endAt ?? "").slice(0, 40),
      String(input.sourceSummary ?? "").slice(0, 2000),
      results.length,
      unique.size,
      0,
      timestamp,
      timestamp,
    )
    .run();

  const values = [...unique.values()];
  for (let offset = 0; offset < values.length; offset += 40) {
    const chunk = values.slice(offset, offset + 40);
    const statements = [];
    for (const item of chunk) {
      const id = crypto.randomUUID();
      const status = String(
        item.status ?? (tool === "missav" ? "pending" : "success"),
      ).slice(0, 64);
      const secondary = String(item.secondaryValue ?? "").slice(0, 4000);
      const tags = json(
        Array.isArray(item.tags) ? item.tags.slice(0, 200) : [],
        [],
      );
      const actressTags = json(
        Array.isArray(item.actressTags) ? item.actressTags.slice(0, 200) : [],
        [],
      );
      const genreTags = json(
        Array.isArray(item.genreTags) ? item.genreTags.slice(0, 200) : [],
        [],
      );
      const source = String(item.source ?? "").slice(0, 1000);
      const permanentSource = safeHttpUrl(
        [source, secondary, item.primaryValue].find((value) => /^https?:\/\//i.test(String(value ?? ""))) || "",
      );
      const missavUrl = tool === "missav" && /\/\/(?:[^/]+\.)?missav\.(?:ai|ws)\//i.test(permanentSource) ? permanentSource : "";
      const av123Url = tool === "av123" && /\/\/(?:[^/]+\.)?123av\.com\//i.test(permanentSource) ? permanentSource : "";
      const metadata = json(item.metadata, {});
      statements.push(
        db
          .prepare(
            `INSERT INTO content_results
        (id,run_id,tool,result_key,primary_value,secondary_value,status,tags_json,source,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            id,
            runId,
            tool,
            item.resultKey,
            item.primaryValue,
            secondary,
            status,
            tags,
            source,
            metadata,
            timestamp,
            timestamp,
          ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO permanent_records
        (id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tool,record_key) DO UPDATE SET
          primary_value=excluded.primary_value,
          secondary_value=CASE WHEN excluded.secondary_value<>'' THEN excluded.secondary_value ELSE permanent_records.secondary_value END,
          status=excluded.status,
          tags_json=excluded.tags_json,
          actress_tags_json=excluded.actress_tags_json,
          genre_tags_json=excluded.genre_tags_json,
          source_url=CASE WHEN excluded.source_url<>'' THEN excluded.source_url ELSE permanent_records.source_url END,
          missav_url=CASE WHEN excluded.missav_url<>'' THEN excluded.missav_url ELSE permanent_records.missav_url END,
          av123_url=CASE WHEN excluded.av123_url<>'' THEN excluded.av123_url ELSE permanent_records.av123_url END,
          metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at`,
          )
          .bind(
            id,
            tool,
            item.resultKey,
            item.primaryValue,
            secondary,
            status,
            tags,
            actressTags,
            genreTags,
            permanentSource,
            missavUrl,
            av123Url,
            metadata,
            timestamp,
            timestamp,
          ),
      );
    }
    await db.batch(statements);
  }
  await db
    .prepare(
      `INSERT INTO task_inbox(id,tool,stage,title,run_id,record_id,source_id,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      tool,
      tool === "av123" || tool === "missav" ? "website" : "completed",
      name,
      runId,
      "",
      "",
      json({ resultCount: unique.size }, {}),
      timestamp,
      timestamp,
    )
    .run();
  await writeLog("info", "run", `已保存 ${tool} 处理历史`, {
    runId,
    resultCount: unique.size,
  });
  return { runId, resultCount: unique.size };
}

export async function listRuns(
  page = 1,
  pageSize = 30,
  tool = "",
  search = "",
) {
  await ensureSchema();
  const db = getD1();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (tool) {
    cleanTool(tool);
    clauses.push("tool=?");
    values.push(tool);
  }
  if (search.trim()) {
    clauses.push("name LIKE ?");
    values.push(`%${search.trim().slice(0, 160)}%`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const safePage = Math.max(1, Math.trunc(page));
  const safeSize = Math.min(100, Math.max(10, Math.trunc(pageSize)));
  const [count, rows] = await db.batch([
    db
      .prepare(`SELECT COUNT(*) AS count FROM content_runs${where}`)
      .bind(...values),
    db
      .prepare(
        `SELECT * FROM content_runs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, safeSize, (safePage - 1) * safeSize),
  ]);
  return {
    rows: rows.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
    page: safePage,
    pageSize: safeSize,
  };
}

export async function getRun(id: string, resultPage = 1, resultPageSize = 100) {
  await ensureSchema();
  const db = getD1();
  const page = Math.max(1, Math.trunc(Number(resultPage) || 1));
  const pageSize = Math.min(
    500,
    Math.max(20, Math.trunc(Number(resultPageSize) || 100)),
  );
  const [run, count, results] = await db.batch([
    db.prepare("SELECT * FROM content_runs WHERE id=?").bind(id),
    db
      .prepare("SELECT COUNT(*) AS count FROM content_results WHERE run_id=?")
      .bind(id),
    db
      .prepare(
        "SELECT * FROM content_results WHERE run_id=? ORDER BY created_at,id LIMIT ? OFFSET ?",
      )
      .bind(id, pageSize, (page - 1) * pageSize),
  ]);
  if (!run.results?.[0]) throw new Error("历史不存在");
  return {
    run: run.results[0],
    results: results.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function exportRunResults(id: string) {
  await ensureSchema();
  const [run, rows] = await getD1().batch([
    getD1().prepare("SELECT * FROM content_runs WHERE id=?").bind(id),
    getD1()
      .prepare(
        "SELECT * FROM content_results WHERE run_id=? ORDER BY created_at,id LIMIT 100001",
      )
      .bind(id),
  ]);
  if (!run.results?.[0]) throw new Error("历史不存在");
  if ((rows.results?.length ?? 0) > 100_000)
    throw new Error("单批次导出超过 10 万条，请先在数据中心按条件导出");
  return JSON.stringify(
    {
      exportedAt: nowIso(),
      run: run.results[0],
      count: rows.results?.length ?? 0,
      results: rows.results ?? [],
    },
    null,
    2,
  );
}

export async function mutateRun(
  id: string,
  action: "rename" | "delete",
  name = "",
) {
  await ensureSchema();
  const db = getD1();
  if (action === "delete") {
    const snapshotId = await createRunSnapshot(id, "删除处理历史前自动恢复点");
    await db.prepare("DELETE FROM content_runs WHERE id=?").bind(id).run();
    await writeLog("warning", "history", "已删除处理历史", { id, snapshotId });
    return { deleted: true, snapshotId };
  }
  const clean = name.trim().slice(0, 160);
  if (!clean) throw new Error("名称不能为空");
  return db
    .prepare("UPDATE content_runs SET name=?,updated_at=? WHERE id=?")
    .bind(clean, nowIso(), id)
    .run();
}

export async function listRecords(
  input: RecordFilters & { page?: number; pageSize?: number },
) {
  await ensureSchema();
  const db = getD1();
  const filters = filterSql(input);
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(20, Math.trunc(Number(input.pageSize) || 50)),
  );
  const sort = SORT_FIELDS[String(input.sort)] ?? "updated_at";
  const direction = input.direction === "asc" ? "ASC" : "DESC";
  const [count, rows] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM permanent_records${filters.where}`,
      )
      .bind(...filters.values),
    db
      .prepare(
        `SELECT * FROM permanent_records${filters.where} ORDER BY ${sort} ${direction},id ${direction} LIMIT ? OFFSET ?`,
      )
      .bind(...filters.values, pageSize, (page - 1) * pageSize),
  ]);
  return {
    rows: (rows.results ?? []).map((row) =>
      recordFromRow(row as Record<string, unknown>),
    ),
    total: Number(count.results?.[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function createRecord(input: SanitizedImportRecord) {
  await ensureSchema();
  const db = getD1();
  const tool = cleanTool(input.tool);
  const recordKey = String(input.recordKey ?? "")
    .trim()
    .slice(0, 300);
  const primary = String(input.primaryValue ?? "")
    .trim()
    .slice(0, 1000);
  if (!recordKey || !primary) throw new Error("唯一键和主值不能为空");
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO permanent_records
    (id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      tool,
      recordKey,
      primary,
      String(input.secondaryValue ?? "").slice(0, 4000),
      String(input.status ?? "manual").slice(0, 64),
      json(input.tags, []),
      json(input.actressTags, []),
      json(input.genreTags, []),
      String(input.sourceUrl ?? "").slice(0, 4000),
      String(input.missavUrl ?? "").slice(0, 4000),
      String(input.av123Url ?? "").slice(0, 4000),
      json(input.metadata, {}),
      timestamp,
      timestamp,
    )
    .run();
  return { id };
}

function editableValue(field: string, value: unknown) {
  if (!EDITABLE_FIELDS[field]) throw new Error("不允许编辑该字段");
  if (["tags", "actressTags", "genreTags"].includes(field))
    return json(Array.isArray(value) ? value : [], []);
  if (field === "metadata") return json(value, {});
  return String(value ?? "")
    .trim()
    .slice(
      0,
      field.includes("Url") || field === "secondaryValue" ? 4000 : 1000,
    );
}

export async function updateRecord(id: string, field: string, value: unknown) {
  await ensureSchema();
  const column = EDITABLE_FIELDS[field];
  const clean = editableValue(field, value);
  const snapshotId = await createRecordSnapshot(
    [id],
    `编辑${field}前自动恢复点`,
  );
  const result = await getD1()
    .prepare(`UPDATE permanent_records SET ${column}=?,updated_at=? WHERE id=?`)
    .bind(clean, nowIso(), id)
    .run();
  await writeLog("info", "records", "已编辑永久记录", {
    id,
    field,
    snapshotId,
  });
  return result;
}

export async function updateRecordFields(
  id: string,
  values: Record<string, unknown>,
) {
  await ensureSchema();
  const entries = Object.entries(values).filter(([field]) =>
    Boolean(EDITABLE_FIELDS[field]),
  );
  if (!entries.length) throw new Error("没有可粘贴的可编辑字段");
  const snapshotId = await createRecordSnapshot(
    [id],
    "粘贴表格区域前自动恢复点",
  );
  const assignments = entries
    .map(([field]) => `${EDITABLE_FIELDS[field]}=?`)
    .join(",");
  const bound = entries.map(([field, value]) => editableValue(field, value));
  const result = await getD1()
    .prepare(
      `UPDATE permanent_records SET ${assignments},updated_at=? WHERE id=?`,
    )
    .bind(...bound, nowIso(), id)
    .run();
  await writeLog("info", "records", "已粘贴表格区域", {
    id,
    fields: entries.map(([field]) => field),
    snapshotId,
  });
  return { changed: Number(result.meta?.changes ?? 0), snapshotId };
}

export async function replaceRecords(input: {
  mode: "ids" | "all";
  ids?: string[];
  excludeIds?: string[];
  filters?: RecordFilters;
  field: string;
  find: string;
  replace: string;
}) {
  await ensureSchema();
  const column = EDITABLE_FIELDS[input.field];
  if (
    !column ||
    ["tags", "actressTags", "genreTags", "metadata"].includes(input.field)
  )
    throw new Error("该字段不支持文本查找替换");
  const needle = String(input.find ?? "");
  if (!needle) throw new Error("查找内容不能为空");
  const excluded = new Set((input.excludeIds ?? []).map(String));
  const ids =
    input.mode === "ids"
      ? [...new Set((input.ids ?? []).map(String).filter(Boolean))]
      : (await recordIdsForFilters(input.filters ?? {})).filter(
          (id) => !excluded.has(id),
        );
  if (!ids.length) return { changed: 0 };
  const snapshotId = await createRecordSnapshot(ids, "查找替换前自动恢复点");
  const rows = await recordRowsForIds(ids);
  let changed = 0;
  for (let offset = 0; offset < rows.length; offset += 80) {
    const statements = [];
    for (const row of rows.slice(offset, offset + 80)) {
      const original = String(row[input.field as keyof RecordRow] ?? "");
      if (!original.includes(needle)) continue;
      statements.push(
        getD1()
          .prepare(
            `UPDATE permanent_records SET ${column}=?,updated_at=? WHERE id=?`,
          )
          .bind(
            original.split(needle).join(input.replace).slice(0, 4000),
            nowIso(),
            row.id,
          ),
      );
    }
    if (statements.length) {
      const results = await getD1().batch(statements);
      changed += results.reduce(
        (sum, result) => sum + Number(result.meta?.changes ?? 0),
        0,
      );
    }
  }
  await writeLog("info", "records", "已完成查找替换", {
    field: input.field,
    changed,
    snapshotId,
  });
  return { changed, snapshotId };
}

export async function exportSelectedRecords(input: {
  mode: "ids" | "all";
  ids?: string[];
  excludeIds?: string[];
  filters?: RecordFilters;
  format: "csv" | "json" | "txt" | "tsv";
}) {
  await ensureSchema();
  const excluded = new Set((input.excludeIds ?? []).map(String));
  const ids =
    input.mode === "ids"
      ? [...new Set((input.ids ?? []).map(String).filter(Boolean))]
      : (await recordIdsForFilters(input.filters ?? {})).filter(
          (id) => !excluded.has(id),
        );
  if (ids.length > 100_000)
    throw new Error("导出范围超过 10 万条，请先缩小筛选条件");
  const rows = await recordRowsForIds(ids);
  if (input.format === "json")
    return JSON.stringify(
      { exportedAt: nowIso(), count: rows.length, records: rows },
      null,
      2,
    );
  if (input.format === "txt")
    return rows.map((row) => row.primaryValue).join("\r\n");
  if (input.format === "tsv")
    return rows
      .map((row) =>
        [
          row.tool,
          row.primaryValue,
          row.secondaryValue,
          row.status,
          row.tags.join("|"),
        ].join("\t"),
      )
      .join("\r\n");
  const header = [
    "id",
    "tool",
    "record_key",
    "primary_value",
    "secondary_value",
    "status",
    "tags",
    "actress_tags",
    "genre_tags",
    "source_url",
    "missav_url",
    "av123_url",
    "metadata",
    "created_at",
    "updated_at",
  ];
  return `\uFEFF${[header.map(csvSafe).join(","), ...rows.map((row) => [row.id, row.tool, row.recordKey, row.primaryValue, row.secondaryValue, row.status, row.tags.join("|"), row.actressTags.join("|"), row.genreTags.join("|"), row.sourceUrl, row.missavUrl, row.av123Url, JSON.stringify(row.metadata), row.createdAt, row.updatedAt].map(csvSafe).join(","))].join("\r\n")}`;
}

export async function bulkRecords(input: {
  action: "update" | "delete";
  mode: "ids" | "all";
  ids?: string[];
  excludeIds?: string[];
  filters?: RecordFilters;
  field?: string;
  value?: unknown;
}) {
  await ensureSchema();
  const db = getD1();
  const timestamp = nowIso();
  const updateColumn =
    input.action === "update" ? EDITABLE_FIELDS[String(input.field)] : "";
  const updateValue =
    input.action === "update"
      ? editableValue(String(input.field), input.value)
      : "";
  if (input.action === "update" && !updateColumn)
    throw new Error("不允许批量编辑该字段");
  const excluded = new Set((input.excludeIds ?? []).map(String));
  const ids =
    input.mode === "ids"
      ? [...new Set((input.ids ?? []).map(String).filter(Boolean))]
      : (await recordIdsForFilters(input.filters ?? {})).filter(
          (id) => !excluded.has(id),
        );
  if (!ids.length) return { changed: 0 };
  const snapshotId = await createRecordSnapshot(
    ids,
    `${input.action === "delete" ? "批量删除" : "批量修改"}前自动恢复点`,
  );
  let changed = 0;
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const statement =
      input.action === "delete"
        ? db
            .prepare(
              `DELETE FROM permanent_records WHERE id IN (${placeholders})`,
            )
            .bind(...chunk)
        : db
            .prepare(
              `UPDATE permanent_records SET ${updateColumn}=?,updated_at=? WHERE id IN (${placeholders})`,
            )
            .bind(updateValue, timestamp, ...chunk);
    const result = await statement.run();
    changed += Number(result.meta?.changes ?? 0);
  }
  await writeLog(
    input.action === "delete" ? "warning" : "info",
    "records",
    input.action === "delete" ? "已批量删除永久记录" : "已批量修改永久记录",
    { changed, snapshotId },
  );
  return { changed, snapshotId };
}

export async function getSettings() {
  await ensureSchema();
  const rows = await getD1()
    .prepare("SELECT key,value_json,updated_at FROM app_settings ORDER BY key")
    .all();
  const settings: Record<string, unknown> = Object.fromEntries(
    (rows.results ?? []).map((row) => [
      String(row.key),
      parsed<unknown>(row.value_json, null),
    ]),
  );
  if (!Array.isArray(settings.referenceTags) || !settings.referenceTags.length)
    settings.referenceTags = defaultReferenceTagsRaw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  if (!Array.isArray(settings.referenceBlacklist))
    settings.referenceBlacklist = [];
  if (!Array.isArray(settings.exportBlacklist)) settings.exportBlacklist = [];
  return settings;
}

export async function setSettings(values: Record<string, unknown>) {
  await ensureSchema();
  const db = getD1();
  const allowed = new Set([
    "referenceTags",
    "referenceBlacklist",
    "exportBlacklist",
  ]);
  const keys = Object.keys(values).filter((key) => allowed.has(key));
  const snapshotId = keys.length
    ? await createSettingsSnapshot(keys, "修改规则资料库前自动恢复点")
    : "";
  const timestamp = nowIso();
  const statements = Object.entries(values)
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => {
      const list = Array.isArray(value)
        ? value
            .map((item) => String(item).trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 20_000)
        : [];
      return db
        .prepare(
          `INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
        )
        .bind(key, json([...new Set(list)], []), timestamp);
    });
  if (statements.length) await db.batch(statements);
  if (statements.length)
    await writeLog("warning", "settings", "已更新规则资料库", {
      keys,
      snapshotId,
    });
  return getSettings();
}

export async function listImportBatches(limit = 20) {
  await ensureSchema();
  const rows = await getD1()
    .prepare("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?")
    .bind(Math.min(100, Math.max(1, limit)))
    .all();
  return rows.results ?? [];
}

function sanitizeImportRecord(raw: SanitizedImportRecord) {
  const tool = cleanTool(raw.tool);
  const recordKey = String(raw.recordKey ?? "")
    .trim()
    .slice(0, 300);
  const primaryValue = String(raw.primaryValue ?? "")
    .trim()
    .slice(0, 1000);
  if (!recordKey || !primaryValue) throw new Error("导入记录缺少唯一键或主值");
  return {
    tool,
    recordKey,
    primaryValue,
    secondaryValue: String(raw.secondaryValue ?? "").slice(0, 4000),
    status: String(raw.status ?? "imported").slice(0, 64),
    tagsJson: json(raw.tags, []),
    actressTagsJson: json(raw.actressTags, []),
    genreTagsJson: json(raw.genreTags, []),
    sourceUrl: String(raw.sourceUrl ?? "").slice(0, 4000),
    missavUrl: String(raw.missavUrl ?? "").slice(0, 4000),
    av123Url: String(raw.av123Url ?? "").slice(0, 4000),
    metadataJson: json(raw.metadata, {}),
  };
}

export async function migrationAction(input: Record<string, unknown>) {
  await ensureSchema();
  const db = getD1();
  const action = String(input.action ?? "");
  const timestamp = nowIso();
  if (action === "preview") {
    const records = (Array.isArray(input.records) ? input.records : [])
      .slice(0, 100)
      .map((row) => sanitizeImportRecord(row as SanitizedImportRecord));
    const items = [];
    for (const row of records) {
      const existing = await db
        .prepare(
          "SELECT * FROM permanent_records WHERE tool=? AND record_key=?",
        )
        .bind(row.tool, row.recordKey)
        .first();
      if (!existing) {
        items.push({
          tool: row.tool,
          recordKey: row.recordKey,
          primaryValue: row.primaryValue,
          case: "new",
        });
        continue;
      }
      const exact =
        String(existing.primary_value) === row.primaryValue &&
        String(existing.secondary_value ?? "") === row.secondaryValue &&
        String(existing.status ?? "") === row.status &&
        String(existing.tags_json ?? "[]") === row.tagsJson &&
        String(existing.actress_tags_json ?? "[]") === row.actressTagsJson &&
        String(existing.genre_tags_json ?? "[]") === row.genreTagsJson &&
        String(existing.source_url ?? "") === row.sourceUrl &&
        String(existing.missav_url ?? "") === row.missavUrl &&
        String(existing.av123_url ?? "") === row.av123Url;
      items.push({
        tool: row.tool,
        recordKey: row.recordKey,
        primaryValue: row.primaryValue,
        case: exact ? "duplicate_exact" : "conflict",
        existing: exact
          ? undefined
          : {
              primaryValue: existing.primary_value,
              status: existing.status,
              sourceUrl: existing.source_url,
              missavUrl: existing.missav_url,
              av123Url: existing.av123_url,
            },
      });
    }
    return {
      items,
      counts: items.reduce<Record<string, number>>(
        (counts, item) => ({
          ...counts,
          [item.case]: (counts[item.case] || 0) + 1,
        }),
        {},
      ),
    };
  }
  if (action === "start") {
    const id = crypto.randomUUID();
    const strategy =
      input.strategy === "overwrite" ? "overwrite" : "skip_conflicts";
    const snapshotId = await createRecordSnapshot(
      await recordIdsForFilters({}),
      "数据迁移前完整永久库恢复点",
      true,
    );
    const counts = {
      ...(input.counts && typeof input.counts === "object"
        ? (input.counts as Record<string, unknown>)
        : {}),
      strategy,
      snapshotId,
    };
    await db
      .prepare(
        `INSERT INTO import_batches
      (id,file_name,checksum,status,total_rows,valid_rows,rejected_rows,applied_rows,counts_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id,
        String(input.fileName ?? "脱敏导入").slice(0, 240),
        String(input.checksum ?? "").slice(0, 128),
        "importing",
        Number(input.totalRows ?? 0),
        Number(input.validRows ?? 0),
        Number(input.rejectedRows ?? 0),
        0,
        json(counts, {}),
        timestamp,
        timestamp,
      )
      .run();
    await writeLog("warning", "migration", "已建立迁移批次和完整恢复点", {
      batchId: id,
      strategy,
      snapshotId,
    });
    return { batchId: id, snapshotId };
  }
  const batchId = String(input.batchId ?? "");
  if (!batchId) throw new Error("缺少导入批次");
  if (action === "append") {
    const rawRecords = (
      Array.isArray(input.records) ? input.records : []
    ).slice(0, 40) as SanitizedImportRecord[];
    const records = rawRecords.map((row) => sanitizeImportRecord(row));
    const chunkIndex = Math.max(0, Math.trunc(Number(input.chunkIndex)));
    const submittedChecksum = String(input.chunkChecksum ?? "");
    const verifiedChecksum = await sha256Hex(JSON.stringify(rawRecords));
    if (!submittedChecksum || submittedChecksum !== verifiedChecksum)
      throw new Error(`迁移分块 ${chunkIndex + 1} 校验失败，未写入任何记录。`);
    const batch = await db
      .prepare("SELECT * FROM import_batches WHERE id=? AND status='importing'")
      .bind(batchId)
      .first();
    if (!batch) throw new Error("导入批次不存在或状态无效");
    const existingChunk = await db
      .prepare(
        "SELECT checksum,row_count,applied_count FROM import_batch_chunks WHERE batch_id=? AND chunk_index=?",
      )
      .bind(batchId, chunkIndex)
      .first();
    if (existingChunk) {
      if (
        String(existingChunk.checksum) !== verifiedChecksum ||
        Number(existingChunk.row_count) !== records.length
      )
        throw new Error(`迁移分块 ${chunkIndex + 1} 与已接收内容冲突。`);
      return {
        appended: Number(existingChunk.applied_count ?? 0),
        skipped: records.length - Number(existingChunk.applied_count ?? 0),
        replayed: true,
      };
    }
    const batchInfo = parsed<Record<string, unknown>>(batch.counts_json, {});
    const strategy =
      batchInfo.strategy === "overwrite" ? "overwrite" : "skip_conflicts";
    let applied = 0;
    const statements = [];
    for (const row of records) {
      const already = await db
        .prepare(
          "SELECT id FROM import_changes WHERE batch_id=? AND tool=? AND record_key=?",
        )
        .bind(batchId, row.tool, row.recordKey)
        .first();
      if (already) continue;
      const existing = await db
        .prepare(
          "SELECT * FROM permanent_records WHERE tool=? AND record_key=?",
        )
        .bind(row.tool, row.recordKey)
        .first();
      const exact =
        existing &&
        String(existing.primary_value) === row.primaryValue &&
        String(existing.secondary_value ?? "") === row.secondaryValue &&
        String(existing.status ?? "") === row.status &&
        String(existing.tags_json ?? "[]") === row.tagsJson &&
        String(existing.actress_tags_json ?? "[]") === row.actressTagsJson &&
        String(existing.genre_tags_json ?? "[]") === row.genreTagsJson &&
        String(existing.source_url ?? "") === row.sourceUrl &&
        String(existing.missav_url ?? "") === row.missavUrl &&
        String(existing.av123_url ?? "") === row.av123Url;
      if (exact || (existing && strategy === "skip_conflicts")) continue;
      const insertedId = crypto.randomUUID();
      const changePayload = existing
        ? { previous: existing, importedUpdatedAt: timestamp }
        : { insertedId, importedUpdatedAt: timestamp };
      const change = db
        .prepare(
          `INSERT OR IGNORE INTO import_changes(batch_id,tool,record_key,action,previous_json,created_at) VALUES (?,?,?,?,?,?)`,
        )
        .bind(
          batchId,
          row.tool,
          row.recordKey,
          existing ? "update" : "insert",
          json(changePayload, {}),
          timestamp,
        );
      const upsert = db
        .prepare(
          `INSERT INTO permanent_records
        (id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tool,record_key) DO UPDATE SET primary_value=excluded.primary_value,secondary_value=excluded.secondary_value,
          status=excluded.status,tags_json=excluded.tags_json,actress_tags_json=excluded.actress_tags_json,
          genre_tags_json=excluded.genre_tags_json,source_url=excluded.source_url,missav_url=excluded.missav_url,
          av123_url=excluded.av123_url,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
        )
        .bind(
          insertedId,
          row.tool,
          row.recordKey,
          row.primaryValue,
          row.secondaryValue,
          row.status,
          row.tagsJson,
          row.actressTagsJson,
          row.genreTagsJson,
          row.sourceUrl,
          row.missavUrl,
          row.av123Url,
          row.metadataJson,
          timestamp,
          timestamp,
        );
      statements.push(change, upsert);
      applied += 1;
    }
    statements.push(
      db
        .prepare(
          "INSERT INTO import_batch_chunks(batch_id,chunk_index,checksum,row_count,applied_count,created_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          batchId,
          chunkIndex,
          verifiedChecksum,
          records.length,
          applied,
          timestamp,
        ),
      db
        .prepare(
          "UPDATE import_batches SET applied_rows=applied_rows+?,updated_at=? WHERE id=? AND status='importing'",
        )
        .bind(applied, timestamp, batchId),
    );
    await db.batch(statements);
    return { appended: applied, skipped: records.length - applied };
  }
  if (action === "complete") {
    const expectedChunks = Math.max(
      0,
      Math.trunc(Number(input.expectedChunks)),
    );
    const expectedRows = Math.max(0, Math.trunc(Number(input.expectedRows)));
    const [verified, batch] = await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) AS chunks,COALESCE(SUM(row_count),0) AS rows FROM import_batch_chunks WHERE batch_id=?",
        )
        .bind(batchId)
        .first(),
      db
        .prepare(
          "SELECT valid_rows FROM import_batches WHERE id=? AND status='importing'",
        )
        .bind(batchId)
        .first(),
    ]);
    if (
      !batch ||
      Number(batch.valid_rows) !== expectedRows ||
      Number(verified?.chunks ?? 0) !== expectedChunks ||
      Number(verified?.rows ?? 0) !== expectedRows
    )
      throw new Error(
        "服务端分块数量核对失败，批次保持未完成状态，可继续上传。 ",
      );
    await db
      .prepare(
        "UPDATE import_batches SET status='applied',updated_at=? WHERE id=? AND status='importing'",
      )
      .bind(timestamp, batchId)
      .run();
    return { completed: true };
  }
  if (action === "rollback-start") {
    await db
      .prepare(
        "UPDATE import_batches SET status='rolling_back',updated_at=? WHERE id=? AND status IN ('applied','importing')",
      )
      .bind(timestamp, batchId)
      .run();
    return { started: true };
  }
  if (action === "rollback-step") {
    const changes = await db
      .prepare(
        "SELECT * FROM import_changes WHERE batch_id=? ORDER BY id DESC LIMIT 50",
      )
      .bind(batchId)
      .all();
    for (const raw of changes.results ?? []) {
      const row = raw as Record<string, unknown>;
      const payload = parsed<Record<string, unknown>>(row.previous_json, {});
      const importedUpdatedAt = String(payload.importedUpdatedAt ?? "");
      if (row.action === "insert") {
        const result = importedUpdatedAt
          ? await db
              .prepare(
                "DELETE FROM permanent_records WHERE tool=? AND record_key=? AND updated_at=?",
              )
              .bind(row.tool, row.record_key, importedUpdatedAt)
              .run()
          : await db
              .prepare(
                "DELETE FROM permanent_records WHERE tool=? AND record_key=?",
              )
              .bind(row.tool, row.record_key)
              .run();
        if (importedUpdatedAt && Number(result.meta?.changes ?? 0) === 0)
          throw new Error(
            `记录 ${String(row.record_key)} 在导入后被修改，已停止回滚；可改用完整恢复点。`,
          );
      } else {
        const previous = (
          payload.previous && typeof payload.previous === "object"
            ? payload.previous
            : payload
        ) as Record<string, unknown>;
        const result = await db
          .prepare(
            `UPDATE permanent_records SET primary_value=?,secondary_value=?,status=?,tags_json=?,actress_tags_json=?,genre_tags_json=?,
          source_url=?,missav_url=?,av123_url=?,metadata_json=?,created_at=?,updated_at=? WHERE tool=? AND record_key=? AND updated_at=?`,
          )
          .bind(
            previous.primary_value,
            previous.secondary_value,
            previous.status,
            previous.tags_json,
            previous.actress_tags_json,
            previous.genre_tags_json,
            previous.source_url,
            previous.missav_url,
            previous.av123_url,
            previous.metadata_json,
            previous.created_at,
            previous.updated_at,
            row.tool,
            row.record_key,
            importedUpdatedAt,
          )
          .run();
        if (!result.success || Number(result.meta?.changes ?? 0) === 0)
          throw new Error(
            `记录 ${String(row.record_key)} 在导入后被修改，已停止回滚；可改用完整恢复点。`,
          );
      }
      await db
        .prepare("DELETE FROM import_changes WHERE id=?")
        .bind(row.id)
        .run();
    }
    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM import_changes WHERE batch_id=?")
      .bind(batchId)
      .first();
    const count = Number(remaining?.count ?? 0);
    if (!count)
      await db
        .prepare(
          "UPDATE import_batches SET status='rolled_back',updated_at=? WHERE id=?",
        )
        .bind(timestamp, batchId)
        .run();
    return { remaining: count };
  }
  throw new Error("未知迁移动作");
}

export async function exportRecords(
  filters: RecordFilters,
  format: "csv" | "json" | "txt" | "tsv",
) {
  await ensureSchema();
  const query = filterSql(filters);
  const rows = await getD1()
    .prepare(
      `SELECT * FROM permanent_records${query.where} ORDER BY updated_at DESC LIMIT 100001`,
    )
    .bind(...query.values)
    .all();
  if ((rows.results?.length ?? 0) > 100_000)
    throw new Error("导出范围超过 10 万条，请先增加筛选条件");
  const mapped = (rows.results ?? []).map((row) =>
    recordFromRow(row as Record<string, unknown>),
  );
  if (format === "json")
    return JSON.stringify(
      { exportedAt: nowIso(), count: mapped.length, records: mapped },
      null,
      2,
    );
  if (format === "txt")
    return mapped.map((row) => row.primaryValue).join("\r\n");
  if (format === "tsv")
    return mapped
      .map((row) =>
        [
          row.tool,
          row.primaryValue,
          row.secondaryValue,
          row.status,
          row.tags.join("|"),
        ].join("\t"),
      )
      .join("\r\n");
  const header = [
    "id",
    "tool",
    "record_key",
    "primary_value",
    "secondary_value",
    "status",
    "tags",
    "actress_tags",
    "genre_tags",
    "source_url",
    "missav_url",
    "av123_url",
    "metadata",
    "created_at",
    "updated_at",
  ];
  return `\uFEFF${[header.map(csvSafe).join(","), ...mapped.map((row) => [row.id, row.tool, row.recordKey, row.primaryValue, row.secondaryValue, row.status, row.tags.join("|"), row.actressTags.join("|"), row.genreTags.join("|"), row.sourceUrl, row.missavUrl, row.av123Url, JSON.stringify(row.metadata), row.createdAt, row.updatedAt].map(csvSafe).join(","))].join("\r\n")}`;
}

export async function exportRaindrop(
  filters: RecordFilters,
  format: "csv" | "html",
) {
  await ensureSchema();
  const query = filterSql({ ...filters, tool: "missav" });
  const [rows, setting] = await getD1().batch([
    getD1()
      .prepare(
        `SELECT * FROM permanent_records${query.where} ORDER BY updated_at DESC LIMIT 100001`,
      )
      .bind(...query.values),
    getD1().prepare(
      "SELECT value_json FROM app_settings WHERE key='exportBlacklist'",
    ),
  ]);
  if ((rows.results?.length ?? 0) > 100_000)
    throw new Error("Raindrop 导出超过 10 万条，请先增加筛选条件");
  const blacklist = parsed<string[]>(setting.results?.[0]?.value_json, []);
  const all = (rows.results ?? []).map((row) =>
    recordFromRow(row as Record<string, unknown>),
  );
  return buildRaindropExport(all, blacklist, format);
}

import { getD1 } from "../db";
import type { RecordFilters, RecordRow, SanitizedImportRecord, ToolResult } from "./types";

const TOOLS = new Set(["twitter", "badnews", "haijiao", "missav"]);
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
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parsed<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; }
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
    ];
    await db.batch(statements.map((statement) => db.prepare(statement)));
  })().catch((error) => { schemaReady = null; throw error; });
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
  if (filters.tool) { cleanTool(filters.tool); clauses.push(`${column("tool") } = ?`); values.push(filters.tool); }
  if (filters.status) { clauses.push(`${column("status") } = ?`); values.push(String(filters.status).slice(0, 64)); }
  const search = String(filters.search ?? "").trim().slice(0, 240);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(`(${column("record_key")} LIKE ? ESCAPE '\\' OR ${column("primary_value")} LIKE ? ESCAPE '\\' OR ${column("secondary_value")} LIKE ? ESCAPE '\\' OR ${column("tags_json")} LIKE ? ESCAPE '\\' OR ${column("actress_tags_json")} LIKE ? ESCAPE '\\' OR ${column("genre_tags_json")} LIKE ? ESCAPE '\\')`);
    values.push(like, like, like, like, like, like);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

export async function dashboardSummary() {
  await ensureSchema();
  const db = getD1();
  const [records, runs, migrations] = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM permanent_records"),
    db.prepare("SELECT COUNT(*) AS count FROM content_runs"),
    db.prepare("SELECT COUNT(*) AS count FROM import_batches WHERE status='applied'"),
  ]);
  return {
    records: Number(records.results?.[0]?.count ?? 0),
    runs: Number(runs.results?.[0]?.count ?? 0),
    migrations: Number(migrations.results?.[0]?.count ?? 0),
  };
}

export async function saveRun(input: {
  tool: string; name: string; inputKind: string; startAt?: string; endAt?: string;
  sourceSummary?: string; results: ToolResult[];
}) {
  await ensureSchema();
  const db = getD1();
  const tool = cleanTool(input.tool);
  const name = String(input.name ?? "").trim().slice(0, 160);
  if (!name) throw new Error("历史名称不能为空");
  const results = Array.isArray(input.results) ? input.results.slice(0, 100_000) : [];
  const runId = crypto.randomUUID();
  const timestamp = nowIso();
  const unique = new Map<string, ToolResult>();
  for (const item of results) {
    const key = String(item.resultKey ?? "").trim().slice(0, 300);
    const primary = String(item.primaryValue ?? "").trim().slice(0, 1000);
    if (!key || !primary || unique.has(key.toLowerCase())) continue;
    unique.set(key.toLowerCase(), { ...item, resultKey: key, primaryValue: primary });
  }
  await db.prepare(`INSERT INTO content_runs
    (id,tool,name,input_kind,start_at,end_at,source_summary,total_count,result_count,error_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(runId, tool, name, String(input.inputKind ?? "manual").slice(0, 60), String(input.startAt ?? "").slice(0, 40),
      String(input.endAt ?? "").slice(0, 40), String(input.sourceSummary ?? "").slice(0, 2000),
      results.length, unique.size, 0, timestamp, timestamp).run();

  const values = [...unique.values()];
  for (let offset = 0; offset < values.length; offset += 40) {
    const chunk = values.slice(offset, offset + 40);
    const statements = [];
    for (const item of chunk) {
      const id = crypto.randomUUID();
      const status = String(item.status ?? (tool === "missav" ? "pending" : "success")).slice(0, 64);
      const secondary = String(item.secondaryValue ?? "").slice(0, 4000);
      const tags = json(Array.isArray(item.tags) ? item.tags.slice(0, 200) : [], []);
      const source = String(item.source ?? "").slice(0, 1000);
      const permanentSource = [source, secondary, item.primaryValue].find((value) => /^https?:\/\//i.test(String(value ?? ""))) || "";
      const metadata = json(item.metadata, {});
      statements.push(db.prepare(`INSERT INTO content_results
        (id,run_id,tool,result_key,primary_value,secondary_value,status,tags_json,source,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, runId, tool, item.resultKey, item.primaryValue, secondary, status, tags, source, metadata, timestamp, timestamp));
      statements.push(db.prepare(`INSERT INTO permanent_records
        (id,tool,record_key,primary_value,secondary_value,status,tags_json,source_url,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tool,record_key) DO UPDATE SET
          primary_value=excluded.primary_value,
          secondary_value=CASE WHEN excluded.secondary_value<>'' THEN excluded.secondary_value ELSE permanent_records.secondary_value END,
          status=excluded.status,
          tags_json=excluded.tags_json,
          source_url=CASE WHEN excluded.source_url<>'' THEN excluded.source_url ELSE permanent_records.source_url END,
          metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at`)
        .bind(id, tool, item.resultKey, item.primaryValue, secondary, status, tags, permanentSource, metadata, timestamp, timestamp));
    }
    await db.batch(statements);
  }
  return { runId, resultCount: unique.size };
}

export async function listRuns(page = 1, pageSize = 30, tool = "", search = "") {
  await ensureSchema();
  const db = getD1();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (tool) { cleanTool(tool); clauses.push("tool=?"); values.push(tool); }
  if (search.trim()) { clauses.push("name LIKE ?"); values.push(`%${search.trim().slice(0, 160)}%`); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const safePage = Math.max(1, Math.trunc(page));
  const safeSize = Math.min(100, Math.max(10, Math.trunc(pageSize)));
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count FROM content_runs${where}`).bind(...values),
    db.prepare(`SELECT * FROM content_runs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...values, safeSize, (safePage - 1) * safeSize),
  ]);
  return { rows: rows.results ?? [], total: Number(count.results?.[0]?.count ?? 0), page: safePage, pageSize: safeSize };
}

export async function getRun(id: string) {
  await ensureSchema();
  const db = getD1();
  const [run, results] = await db.batch([
    db.prepare("SELECT * FROM content_runs WHERE id=?").bind(id),
    db.prepare("SELECT * FROM content_results WHERE run_id=? ORDER BY created_at,id").bind(id),
  ]);
  if (!run.results?.[0]) throw new Error("历史不存在");
  return { run: run.results[0], results: results.results ?? [] };
}

export async function mutateRun(id: string, action: "rename" | "delete", name = "") {
  await ensureSchema();
  const db = getD1();
  if (action === "delete") return db.prepare("DELETE FROM content_runs WHERE id=?").bind(id).run();
  const clean = name.trim().slice(0, 160);
  if (!clean) throw new Error("名称不能为空");
  return db.prepare("UPDATE content_runs SET name=?,updated_at=? WHERE id=?").bind(clean, nowIso(), id).run();
}

export async function listRecords(input: RecordFilters & { page?: number; pageSize?: number }) {
  await ensureSchema();
  const db = getD1();
  const filters = filterSql(input);
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(200, Math.max(20, Math.trunc(Number(input.pageSize) || 50)));
  const sort = SORT_FIELDS[String(input.sort)] ?? "updated_at";
  const direction = input.direction === "asc" ? "ASC" : "DESC";
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count FROM permanent_records${filters.where}`).bind(...filters.values),
    db.prepare(`SELECT * FROM permanent_records${filters.where} ORDER BY ${sort} ${direction},id ${direction} LIMIT ? OFFSET ?`)
      .bind(...filters.values, pageSize, (page - 1) * pageSize),
  ]);
  return {
    rows: (rows.results ?? []).map((row) => recordFromRow(row as Record<string, unknown>)),
    total: Number(count.results?.[0]?.count ?? 0), page, pageSize,
  };
}

export async function createRecord(input: SanitizedImportRecord) {
  await ensureSchema();
  const db = getD1();
  const tool = cleanTool(input.tool);
  const recordKey = String(input.recordKey ?? "").trim().slice(0, 300);
  const primary = String(input.primaryValue ?? "").trim().slice(0, 1000);
  if (!recordKey || !primary) throw new Error("唯一键和主值不能为空");
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  await db.prepare(`INSERT INTO permanent_records
    (id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, tool, recordKey, primary, String(input.secondaryValue ?? "").slice(0, 4000), String(input.status ?? "manual").slice(0, 64),
      json(input.tags, []), json(input.actressTags, []), json(input.genreTags, []), String(input.sourceUrl ?? "").slice(0, 4000),
      String(input.missavUrl ?? "").slice(0, 4000), String(input.av123Url ?? "").slice(0, 4000), json(input.metadata, {}), timestamp, timestamp).run();
  return { id };
}

function editableValue(field: string, value: unknown) {
  if (!EDITABLE_FIELDS[field]) throw new Error("不允许编辑该字段");
  if (["tags", "actressTags", "genreTags"].includes(field)) return json(Array.isArray(value) ? value : [], []);
  if (field === "metadata") return json(value, {});
  return String(value ?? "").trim().slice(0, field.includes("Url") || field === "secondaryValue" ? 4000 : 1000);
}

export async function updateRecord(id: string, field: string, value: unknown) {
  await ensureSchema();
  const column = EDITABLE_FIELDS[field];
  const clean = editableValue(field, value);
  return getD1().prepare(`UPDATE permanent_records SET ${column}=?,updated_at=? WHERE id=?`).bind(clean, nowIso(), id).run();
}

export async function bulkRecords(input: {
  action: "update" | "delete"; mode: "ids" | "all"; ids?: string[]; excludeIds?: string[];
  filters?: RecordFilters; field?: string; value?: unknown;
}) {
  await ensureSchema();
  const db = getD1();
  const timestamp = nowIso();
  const updateColumn = input.action === "update" ? EDITABLE_FIELDS[String(input.field)] : "";
  const updateValue = input.action === "update" ? editableValue(String(input.field), input.value) : "";
  if (input.action === "update" && !updateColumn) throw new Error("不允许批量编辑该字段");
  if (input.mode === "ids") {
    const ids = [...new Set((input.ids ?? []).map(String))].slice(0, 10_000);
    if (!ids.length) return { changed: 0 };
    let changed = 0;
    for (let offset = 0; offset < ids.length; offset += 90) {
      const chunk = ids.slice(offset, offset + 90);
      const placeholders = chunk.map(() => "?").join(",");
      const statement = input.action === "delete"
        ? db.prepare(`DELETE FROM permanent_records WHERE id IN (${placeholders})`).bind(...chunk)
        : db.prepare(`UPDATE permanent_records SET ${updateColumn}=?,updated_at=? WHERE id IN (${placeholders})`)
          .bind(updateValue, timestamp, ...chunk);
      const result = await statement.run(); changed += Number(result.meta?.changes ?? 0);
    }
    return { changed };
  }
  const filters = filterSql(input.filters ?? {});
  const excluded = [...new Set((input.excludeIds ?? []).map(String))].slice(0, 500);
  let where = filters.where;
  const values = [...filters.values];
  if (excluded.length) {
    where += `${where ? " AND" : " WHERE"} id NOT IN (${excluded.map(() => "?").join(",")})`;
    values.push(...excluded);
  }
  const statement = input.action === "delete"
    ? db.prepare(`DELETE FROM permanent_records${where}`).bind(...values)
    : db.prepare(`UPDATE permanent_records SET ${updateColumn}=?,updated_at=?${where}`)
      .bind(updateValue, timestamp, ...values);
  const result = await statement.run();
  return { changed: Number(result.meta?.changes ?? 0) };
}

export async function getSettings() {
  await ensureSchema();
  const rows = await getD1().prepare("SELECT key,value_json,updated_at FROM app_settings ORDER BY key").all();
  return Object.fromEntries((rows.results ?? []).map((row) => [String(row.key), parsed(row.value_json, null)]));
}

export async function setSettings(values: Record<string, unknown>) {
  await ensureSchema();
  const db = getD1();
  const allowed = new Set(["referenceTags", "referenceBlacklist", "exportBlacklist"]);
  const timestamp = nowIso();
  const statements = Object.entries(values).filter(([key]) => allowed.has(key)).map(([key, value]) => {
    const list = Array.isArray(value) ? value.map((item) => String(item).trim().slice(0, 120)).filter(Boolean).slice(0, 20_000) : [];
    return db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(key, json([...new Set(list)], []), timestamp);
  });
  if (statements.length) await db.batch(statements);
  return getSettings();
}

export async function listImportBatches(limit = 20) {
  await ensureSchema();
  const rows = await getD1().prepare("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?").bind(Math.min(100, Math.max(1, limit))).all();
  return rows.results ?? [];
}

function sanitizeImportRecord(raw: SanitizedImportRecord) {
  const tool = cleanTool(raw.tool);
  const recordKey = String(raw.recordKey ?? "").trim().slice(0, 300);
  const primaryValue = String(raw.primaryValue ?? "").trim().slice(0, 1000);
  if (!recordKey || !primaryValue) throw new Error("导入记录缺少唯一键或主值");
  return {
    tool, recordKey, primaryValue,
    secondaryValue: String(raw.secondaryValue ?? "").slice(0, 4000),
    status: String(raw.status ?? "imported").slice(0, 64),
    tagsJson: json(raw.tags, []), actressTagsJson: json(raw.actressTags, []), genreTagsJson: json(raw.genreTags, []),
    sourceUrl: String(raw.sourceUrl ?? "").slice(0, 4000), missavUrl: String(raw.missavUrl ?? "").slice(0, 4000),
    av123Url: String(raw.av123Url ?? "").slice(0, 4000), metadataJson: json(raw.metadata, {}),
  };
}

export async function migrationAction(input: Record<string, unknown>) {
  await ensureSchema();
  const db = getD1();
  const action = String(input.action ?? "");
  const timestamp = nowIso();
  if (action === "start") {
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO import_batches
      (id,file_name,checksum,status,total_rows,valid_rows,rejected_rows,applied_rows,counts_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, String(input.fileName ?? "脱敏导入").slice(0, 240), String(input.checksum ?? "").slice(0, 128), "importing",
        Number(input.totalRows ?? 0), Number(input.validRows ?? 0), Number(input.rejectedRows ?? 0), 0, json(input.counts, {}), timestamp, timestamp).run();
    return { batchId: id };
  }
  const batchId = String(input.batchId ?? "");
  if (!batchId) throw new Error("缺少导入批次");
  if (action === "append") {
    const records = (Array.isArray(input.records) ? input.records : []).slice(0, 100).map((row) => sanitizeImportRecord(row as SanitizedImportRecord));
    for (const row of records) {
      const existing = await db.prepare("SELECT * FROM permanent_records WHERE tool=? AND record_key=?").bind(row.tool, row.recordKey).first();
      const change = db.prepare(`INSERT OR IGNORE INTO import_changes(batch_id,tool,record_key,action,previous_json,created_at) VALUES (?,?,?,?,?,?)`)
        .bind(batchId, row.tool, row.recordKey, existing ? "update" : "insert", existing ? json(existing, {}) : "", timestamp);
      const upsert = db.prepare(`INSERT INTO permanent_records
        (id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tool,record_key) DO UPDATE SET primary_value=excluded.primary_value,secondary_value=excluded.secondary_value,
          status=excluded.status,tags_json=excluded.tags_json,actress_tags_json=excluded.actress_tags_json,
          genre_tags_json=excluded.genre_tags_json,source_url=excluded.source_url,missav_url=excluded.missav_url,
          av123_url=excluded.av123_url,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(), row.tool, row.recordKey, row.primaryValue, row.secondaryValue, row.status, row.tagsJson,
          row.actressTagsJson, row.genreTagsJson, row.sourceUrl, row.missavUrl, row.av123Url, row.metadataJson, timestamp, timestamp);
      await db.batch([change, upsert]);
    }
    await db.prepare("UPDATE import_batches SET applied_rows=applied_rows+?,updated_at=? WHERE id=? AND status='importing'")
      .bind(records.length, timestamp, batchId).run();
    return { appended: records.length };
  }
  if (action === "complete") {
    await db.prepare("UPDATE import_batches SET status='applied',updated_at=? WHERE id=? AND status='importing'").bind(timestamp, batchId).run();
    return { completed: true };
  }
  if (action === "rollback-start") {
    await db.prepare("UPDATE import_batches SET status='rolling_back',updated_at=? WHERE id=? AND status IN ('applied','importing')").bind(timestamp, batchId).run();
    return { started: true };
  }
  if (action === "rollback-step") {
    const changes = await db.prepare("SELECT * FROM import_changes WHERE batch_id=? ORDER BY id DESC LIMIT 50").bind(batchId).all();
    for (const raw of changes.results ?? []) {
      const row = raw as Record<string, unknown>;
      if (row.action === "insert") {
        await db.prepare("DELETE FROM permanent_records WHERE tool=? AND record_key=?").bind(row.tool, row.record_key).run();
      } else {
        const previous = parsed<Record<string, unknown>>(row.previous_json, {});
        await db.prepare(`UPDATE permanent_records SET primary_value=?,secondary_value=?,status=?,tags_json=?,actress_tags_json=?,genre_tags_json=?,
          source_url=?,missav_url=?,av123_url=?,metadata_json=?,created_at=?,updated_at=? WHERE tool=? AND record_key=?`)
          .bind(previous.primary_value, previous.secondary_value, previous.status, previous.tags_json, previous.actress_tags_json,
            previous.genre_tags_json, previous.source_url, previous.missav_url, previous.av123_url, previous.metadata_json,
            previous.created_at, previous.updated_at, row.tool, row.record_key).run();
      }
      await db.prepare("DELETE FROM import_changes WHERE id=?").bind(row.id).run();
    }
    const remaining = await db.prepare("SELECT COUNT(*) AS count FROM import_changes WHERE batch_id=?").bind(batchId).first();
    const count = Number(remaining?.count ?? 0);
    if (!count) await db.prepare("UPDATE import_batches SET status='rolled_back',updated_at=? WHERE id=?").bind(timestamp, batchId).run();
    return { remaining: count };
  }
  throw new Error("未知迁移动作");
}

export async function exportRecords(filters: RecordFilters, format: "csv" | "json") {
  await ensureSchema();
  const query = filterSql(filters);
  const rows = await getD1().prepare(`SELECT * FROM permanent_records${query.where} ORDER BY updated_at DESC LIMIT 100001`).bind(...query.values).all();
  if ((rows.results?.length ?? 0) > 100_000) throw new Error("导出范围超过 10 万条，请先增加筛选条件");
  const mapped = (rows.results ?? []).map((row) => recordFromRow(row as Record<string, unknown>));
  if (format === "json") return JSON.stringify({ exportedAt: nowIso(), count: mapped.length, records: mapped }, null, 2);
  const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = ["id","tool","record_key","primary_value","secondary_value","status","tags","actress_tags","genre_tags","source_url","missav_url","av123_url","metadata","created_at","updated_at"];
  return `\uFEFF${[header.map(csv).join(","), ...mapped.map((row) => [row.id,row.tool,row.recordKey,row.primaryValue,row.secondaryValue,row.status,row.tags.join("|"),row.actressTags.join("|"),row.genreTags.join("|"),row.sourceUrl,row.missavUrl,row.av123Url,JSON.stringify(row.metadata),row.createdAt,row.updatedAt].map(csv).join(","))].join("\r\n")}`;
}

export async function exportRaindrop(filters: RecordFilters, format: "csv" | "html") {
  await ensureSchema();
  const query = filterSql({ ...filters, tool: "missav" });
  const [rows, setting] = await getD1().batch([
    getD1().prepare(`SELECT * FROM permanent_records${query.where} ORDER BY updated_at DESC LIMIT 100001`).bind(...query.values),
    getD1().prepare("SELECT value_json FROM app_settings WHERE key='exportBlacklist'"),
  ]);
  if ((rows.results?.length ?? 0) > 100_000) throw new Error("Raindrop 导出超过 10 万条，请先增加筛选条件");
  const blacklist = new Set(parsed<string[]>(setting.results?.[0]?.value_json, []).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean));
  const all = (rows.results ?? []).map((row) => recordFromRow(row as Record<string, unknown>));
  const mapped = all.filter((row) => ![...row.tags, ...row.actressTags].some((tag) => blacklist.has(tag.trim().toLocaleLowerCase())));
  const excluded = all.length - mapped.length;
  const urlFor = (row: RecordRow) => row.missavUrl || (/^https?:\/\/(?:[^/]+\.)?missav\.(?:ai|ws)\//i.test(row.sourceUrl) ? row.sourceUrl : "") || `https://missav.ai/cn/${row.primaryValue.toLowerCase()}`;
  const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char] || char));
  if (format === "html") {
    const links = mapped.map((row) => `<DT><A HREF="${html(urlFor(row))}" ADD_DATE="${Math.floor(new Date(row.createdAt).getTime()/1000)}" TAGS="${html([...row.tags,...row.actressTags,...row.genreTags].join(","))}">${html(row.primaryValue)}</A>`).join("\n");
    return { content: `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>MissAV Manager</TITLE>\n<H1>MissAV Manager</H1>\n<DL><p>\n${links}\n</DL><p>`, included: mapped.length, excluded };
  }
  const header = ["id","title","note","excerpt","url","folder","tags","created","cover","highlights","favorite"];
  const output = mapped.map((row,index) => [index+1,row.primaryValue,row.status,"",urlFor(row),"MissAV Manager",[...row.tags,...row.actressTags,...row.genreTags].join(","),row.createdAt,"","","false"].map(csv).join(","));
  return { content: `\uFEFF${[header.map(csv).join(","),...output].join("\r\n")}`, included: mapped.length, excluded };
}

import { getD1 } from "../db";
import {
  backupManifestDigest, backupSha256Hex, backupUtf8Bytes, canonicalJson,
  DATABASE_BACKUP_CANDIDATE_SITE_VERSION, DATABASE_BACKUP_FORMAT,
  DATABASE_BACKUP_INITIAL_DIGEST, DATABASE_BACKUP_PAGE_MAX_ROWS,
  DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES, DATABASE_BACKUP_SITE_VERSION,
  nextBackupDigest, type BackupManifestEntry, type BackupRow,
  type BackupValue, type ColumnInfo,
} from "./database-backup-format";

export {
  DATABASE_BACKUP_CANDIDATE_SITE_VERSION, DATABASE_BACKUP_FORMAT,
  DATABASE_BACKUP_INITIAL_DIGEST, DATABASE_BACKUP_PAGE_MAX_ROWS,
  DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES, DATABASE_BACKUP_SITE_VERSION,
};
export type { BackupManifestEntry, BackupRow, BackupValue, ColumnInfo };

export const DATABASE_BACKUP_SOURCE_COMMIT = "124e80b491eb4b7a3dee5f3e8eb44aeffc317f9e";
export const DATABASE_BACKUP_SOURCE_TREE = "13c743aa695e1b4dde953c993a1bc8517edb8090";
export const BUSINESS_TABLES = [
  "app_logs", "app_settings", "content_results", "content_runs",
  "data_snapshot_items", "data_snapshots", "import_batch_chunks", "import_batches",
  "import_changes", "input_sources", "permanent_records", "script_generations",
  "sync_transactions", "task_inbox", "telegram_accounts", "telegram_auth_flows",
  "telegram_bot_state", "telegram_connections", "telegram_message_fingerprints",
  "telegram_messages", "telegram_migration_runs", "telegram_read_states",
  "telegram_sync_runs", "telegram_tool_queue", "tool_source_bindings",
] as const;

export type BusinessTable = (typeof BUSINESS_TABLES)[number];
export type InventoryTable = {
  name: BusinessTable; rowCount: number; primaryKey: string[];
  columns: ColumnInfo[]; schemaSha256: string;
};
export type DatabaseInventory = {
  inspectedAt: string; source: ReturnType<typeof backupSource>;
  security: ReturnType<typeof backupSecurity>; tableCount: 25; totalRows: number;
  bookmark: string; queryCount: 2; tables: InventoryTable[];
};
export type BackupPageRequest = {
  table: BusinessTable; cursor: BackupValue[] | null; bookmark: string;
};
export type BackupPageResponse = {
  table: BusinessTable; cursor: BackupValue[] | null; nextCursor: BackupValue[] | null;
  done: boolean; rows: BackupRow[]; rowCount: number; utf8Bytes: number;
  maxRows: number; maxUtf8Bytes: number; schemaSha256: string; bookmark: string;
  consistent: boolean; queryCount: 2;
};

type HeaderRecord = {
  type: "header"; format: typeof DATABASE_BACKUP_FORMAT; createdAt: string;
  source: ReturnType<typeof backupSource>; security: ReturnType<typeof backupSecurity>;
  tableCount: 25; pageMaxRows: number; pageMaxUtf8Bytes: number;
  hashAlgorithm: "SHA-256 chained canonical pages";
  consistency: "d1-bookmark-and-double-scan"; startBookmark: string;
};
type FooterRecord = {
  type: "footer"; complete: boolean; tableCount: number; totalRows: number;
  sha256: string; tables: BackupManifestEntry[];
  consistency: "d1-bookmark-and-double-scan"; startBookmark: string; endBookmark: string;
  error?: "source_changed_during_backup" | "backup_interrupted";
};

const TABLE_SET = new Set<string>(BUSINESS_TABLES);
const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;
type D1Session = { prepare(query: string): D1PreparedStatement; getBookmark(): string | null };
type SessionCapableD1 = D1Database & { withSession(constraint?: string): D1Session };

function backupSource() {
  return {
    site: "TG 内容工具箱" as const, siteVersion: DATABASE_BACKUP_SITE_VERSION,
    candidateSiteVersion: DATABASE_BACKUP_CANDIDATE_SITE_VERSION,
    commit: DATABASE_BACKUP_SOURCE_COMMIT, tree: DATABASE_BACKUP_SOURCE_TREE,
    database: "formal-sites-d1" as const,
  };
}

function backupSecurity() {
  return { telegramSession: "opaque-encrypted-ciphertext" as const, decrypted: false as const, displayed: false as const };
}

function quoteIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`不安全数据库标识符：${value}`);
  return `"${value}"`;
}

function sqlString(value: string) { return `'${value.replaceAll("'", "''")}'`; }

function openSession(db: D1Database, constraint: string) {
  const candidate = db as Partial<SessionCapableD1>;
  if (typeof candidate.withSession !== "function") throw new Error("当前 D1 Runtime 不支持 Sessions bookmark，拒绝生成无法证明一致性的备份");
  return candidate.withSession(constraint);
}

function sessionBookmark(session: D1Session) {
  const bookmark = session.getBookmark();
  if (!bookmark) throw new Error("D1 Session 未返回 bookmark，拒绝生成无法证明一致性的备份");
  return bookmark;
}

function normalizeColumns(rows: Array<Record<string, unknown>>) {
  const schemas = new Map<BusinessTable, ColumnInfo[]>();
  for (const table of BUSINESS_TABLES) schemas.set(table, []);
  for (const row of rows) {
    const table = String(row.table_name) as BusinessTable;
    if (!TABLE_SET.has(table)) continue;
    schemas.get(table)?.push({
      name: String(row.name), type: String(row.type || ""),
      notnull: Number(row.not_null || 0), pk: Number(row.pk || 0),
    });
  }
  for (const table of BUSINESS_TABLES) {
    if (!schemas.get(table)?.length) throw new Error(`正式 D1 缺少业务表 ${table}`);
  }
  return schemas;
}

function schemaQuery() {
  const placeholders = BUSINESS_TABLES.map(() => "?").join(",");
  return `SELECT m.name AS table_name, p.cid, p.name, p.type, p."notnull" AS not_null, p.pk
    FROM sqlite_schema AS m, pragma_table_info(m.name) AS p
    WHERE m.type = 'table' AND m.name IN (${placeholders})
    ORDER BY m.name, p.cid`;
}

async function allTableSchemas(db: Pick<D1Database, "prepare">) {
  const result = await db.prepare(schemaQuery()).bind(...BUSINESS_TABLES).all<Record<string, unknown>>();
  return normalizeColumns(result.results ?? []);
}

async function tableColumns(db: Pick<D1Database, "prepare">, table: BusinessTable) {
  const result = await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<Record<string, unknown>>();
  const columns = (result.results ?? []).map((row) => ({
    name: String(row.name), type: String(row.type || ""),
    notnull: Number(row.notnull || 0), pk: Number(row.pk || 0),
  }));
  if (!columns.length) throw new Error(`正式 D1 缺少业务表 ${table}`);
  return columns;
}

function primaryKey(columns: ColumnInfo[]) {
  return columns.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
}

function countsQuery() {
  return BUSINESS_TABLES.map((table) =>
    `(SELECT COUNT(*) FROM ${quoteIdentifier(table)}) AS ${quoteIdentifier(table)}`,
  ).join(",");
}

export async function listDatabaseTables(db: D1Database = getD1()): Promise<DatabaseInventory> {
  const session = openSession(db, "first-primary");
  const schemas = await allTableSchemas(session);
  const countResult = await session.prepare(`SELECT ${countsQuery()}`).first<Record<string, number>>();
  const counts = new Map(BUSINESS_TABLES.map((table) => [table, Number(countResult?.[table] ?? 0)]));
  const tables = await Promise.all(BUSINESS_TABLES.map(async (name) => {
    const columns = schemas.get(name) ?? [];
    const keys = primaryKey(columns);
    if (!keys.length) throw new Error(`${name} 没有稳定主键，拒绝使用游标备份`);
    return {
      name, rowCount: counts.get(name) ?? 0, primaryKey: keys, columns,
      schemaSha256: await backupSha256Hex(canonicalJson(columns)),
    };
  }));
  return {
    inspectedAt: new Date().toISOString(), source: backupSource(), security: backupSecurity(),
    tableCount: 25, totalRows: tables.reduce((sum, table) => sum + table.rowCount, 0),
    bookmark: sessionBookmark(session), queryCount: 2, tables,
  };
}

function rowValues(row: Record<string, unknown>, columns: ColumnInfo[]): BackupRow {
  const output: BackupRow = {};
  for (const column of columns) {
    const value = row[column.name];
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${column.name} 包含备份格式不支持的值`);
    }
    output[column.name] = value as BackupValue;
  }
  return output;
}

function cursorWhere(keys: string[], cursor: BackupValue[] | null) {
  if (!cursor) return { sql: "", values: [] as BackupValue[] };
  if (cursor.length !== keys.length || cursor.some((value) => value === null || (typeof value !== "string" && typeof value !== "number"))) {
    throw new Error("备份游标与稳定主键不匹配");
  }
  const values: BackupValue[] = [];
  const branches = keys.map((key, index) => {
    const terms: string[] = [];
    for (let previous = 0; previous < index; previous += 1) {
      terms.push(`${quoteIdentifier(keys[previous])} = ?`);
      values.push(cursor[previous]);
    }
    terms.push(`${quoteIdentifier(key)} > ?`);
    values.push(cursor[index]);
    return `(${terms.join(" AND ")})`;
  });
  return { sql: `WHERE ${branches.join(" OR ")}`, values };
}

function pageQuery(table: BusinessTable, columns: ColumnInfo[], keys: string[], cursor: BackupValue[] | null) {
  const where = cursorWhere(keys, cursor);
  const orderBy = keys.map(quoteIdentifier).join(",");
  const rowJson = columns.flatMap((column) => [sqlString(column.name), quoteIdentifier(column.name)]).join(",");
  return {
    sql: `WITH candidates AS (
      SELECT json_object(${rowJson}) AS row_json,
        ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS row_number
      FROM ${quoteIdentifier(table)}
      ${where.sql}
      ORDER BY ${orderBy}
      LIMIT ?
    ), sized AS (
      SELECT row_json, row_number,
        SUM(length(CAST(row_json AS BLOB)) + 1) OVER (
          ORDER BY row_number ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_bytes
      FROM candidates
    )
    SELECT row_json, row_number, cumulative_bytes,
      (SELECT COUNT(*) FROM sized) AS candidate_count
    FROM sized
    WHERE cumulative_bytes <= ? OR row_number = 1 OR row_number = (
      SELECT MIN(row_number) FROM sized WHERE cumulative_bytes > ?
    )
    ORDER BY row_number`,
    values: [...where.values, DATABASE_BACKUP_PAGE_MAX_ROWS + 1,
      DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES, DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES],
  };
}

export async function readDatabaseBackupPage(input: BackupPageRequest, db: D1Database = getD1()): Promise<BackupPageResponse> {
  if (!TABLE_SET.has(input.table)) throw new Error("备份表不在正式 25 表允许列表中");
  if (!input.bookmark || input.bookmark.length > 512) throw new Error("备份起始 bookmark 无效");
  const session = openSession(db, input.bookmark);
  const columns = await tableColumns(session, input.table);
  const keys = primaryKey(columns);
  if (!keys.length) throw new Error(`${input.table} 没有稳定主键，拒绝使用游标备份`);
  const query = pageQuery(input.table, columns, keys, input.cursor);
  const result = await session.prepare(query.sql).bind(...query.values).all<{
    row_json: string; row_number: number; cumulative_bytes: number; candidate_count: number;
  }>();
  const resultRows = result.results ?? [];
  const candidateCount = Number(resultRows[0]?.candidate_count ?? 0);
  const rows: BackupRow[] = [];
  let utf8Bytes = 0;
  for (const value of resultRows) {
    const parsed = rowValues(JSON.parse(String(value.row_json)) as Record<string, unknown>, columns);
    const bytes = backupUtf8Bytes(JSON.stringify(parsed)) + 1;
    if (rows.length && (rows.length >= DATABASE_BACKUP_PAGE_MAX_ROWS || utf8Bytes + bytes > DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES)) break;
    rows.push(parsed);
    utf8Bytes += bytes;
  }
  const last = rows.at(-1);
  const nextCursor = last ? keys.map((key) => last[key]) : input.cursor;
  const bookmark = sessionBookmark(session);
  return {
    table: input.table, cursor: input.cursor, nextCursor,
    done: candidateCount <= rows.length, rows, rowCount: rows.length, utf8Bytes,
    maxRows: DATABASE_BACKUP_PAGE_MAX_ROWS, maxUtf8Bytes: DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES,
    schemaSha256: await backupSha256Hex(canonicalJson(columns)), bookmark,
    consistent: bookmark >= input.bookmark, queryCount: 2,
  };
}

export async function finalizeDatabaseBackup(bookmark: string, db: D1Database = getD1()) {
  if (!bookmark || bookmark.length > 512) throw new Error("备份起始 bookmark 无效");
  const session = openSession(db, bookmark);
  await session.prepare("SELECT 1 AS backup_consistency_probe").first();
  const endBookmark = sessionBookmark(session);
  return { startBookmark: bookmark, endBookmark, consistent: endBookmark >= bookmark, queryCount: 1 as const };
}

export function createBackupHeader(inventory: DatabaseInventory, createdAt = new Date().toISOString()): HeaderRecord {
  return {
    type: "header", format: DATABASE_BACKUP_FORMAT, createdAt,
    source: inventory.source, security: inventory.security, tableCount: 25,
    pageMaxRows: DATABASE_BACKUP_PAGE_MAX_ROWS,
    pageMaxUtf8Bytes: DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES,
    hashAlgorithm: "SHA-256 chained canonical pages",
    consistency: "d1-bookmark-and-double-scan", startBookmark: inventory.bookmark,
  };
}

export async function createBackupFooter(
  tables: BackupManifestEntry[], startBookmark: string, endBookmark: string,
  complete: boolean, error?: FooterRecord["error"],
): Promise<FooterRecord> {
  return {
    type: "footer", complete, tableCount: tables.length,
    totalRows: tables.reduce((sum, table) => sum + table.rowCount, 0),
    sha256: await backupManifestDigest(tables), tables,
    consistency: "d1-bookmark-and-double-scan", startBookmark, endBookmark,
    ...(error ? { error } : {}),
  };
}

async function* readNdjson(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (backupUtf8Bytes(buffer) > MAX_NDJSON_LINE_BYTES && !buffer.includes("\n")) throw new Error("备份记录超过单行大小上限");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          if (backupUtf8Bytes(line) > MAX_NDJSON_LINE_BYTES) throw new Error("备份记录超过单行大小上限");
          yield JSON.parse(line) as Record<string, unknown>;
        }
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      if (backupUtf8Bytes(buffer) > MAX_NDJSON_LINE_BYTES) throw new Error("备份记录超过单行大小上限");
      yield JSON.parse(buffer) as Record<string, unknown>;
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("备份 NDJSON 内容无法解析");
    throw error;
  } finally { reader.releaseLock(); }
}

function assertHeader(record: Record<string, unknown>) {
  if (record.format !== DATABASE_BACKUP_FORMAT) throw new Error("备份格式或版本不受支持");
  const source = record.source as HeaderRecord["source"] | undefined;
  const security = record.security as HeaderRecord["security"] | undefined;
  if (source?.site !== "TG 内容工具箱" || source.siteVersion !== DATABASE_BACKUP_SITE_VERSION) throw new Error("备份来源不是 TG 内容工具箱 Site v26");
  if (security?.telegramSession !== "opaque-encrypted-ciphertext" || security.decrypted !== false || security.displayed !== false) throw new Error("Telegram Session 安全声明缺失");
  if (record.tableCount !== 25 || record.consistency !== "d1-bookmark-and-double-scan" || typeof record.startBookmark !== "string") throw new Error("备份头缺少 25 表或跨请求一致性声明");
}

export async function validateDatabaseBackupStream(stream: ReadableStream<Uint8Array> | null, db?: D1Database) {
  if (!stream) throw new Error("备份文件为空");
  const targetSchemas = db ? await allTableSchemas(db) : null;
  let phase: "header" | "table" | "page" | "footer" | "done" = "header";
  let expectedTableIndex = 0;
  let startBookmark = "";
  let current: { name: BusinessTable; columns: ColumnInfo[]; nextPage: number; rowCount: number; sha256: string } | null = null;
  const tables: BackupManifestEntry[] = [];
  let footer: FooterRecord | null = null;
  for await (const record of readNdjson(stream)) {
    if (phase === "header") {
      if (record.type !== "header") throw new Error("备份缺少头记录");
      assertHeader(record); startBookmark = String(record.startBookmark); phase = "table"; continue;
    }
    if (phase === "done") throw new Error("备份完成标记后仍有多余内容");
    if (record.type === "table") {
      if (phase !== "table" || current) throw new Error("备份表记录顺序无效");
      const name = String(record.name) as BusinessTable;
      if (!TABLE_SET.has(name) || name !== BUSINESS_TABLES[expectedTableIndex]) throw new Error("备份表清单或顺序与正式 25 表不一致");
      const columns = record.columns as ColumnInfo[];
      if (!Array.isArray(columns) || !columns.length || new Set(columns.map((column) => column.name)).size !== columns.length) throw new Error(`${name} 列定义无效`);
      if (targetSchemas && canonicalJson(targetSchemas.get(name)) !== canonicalJson(columns)) throw new Error(`${name} 与目标 D1 Schema 不一致`);
      current = { name, columns, nextPage: 0, rowCount: 0, sha256: DATABASE_BACKUP_INITIAL_DIGEST };
      phase = "page"; continue;
    }
    if (record.type === "page") {
      if (phase !== "page" || !current || record.table !== current.name || record.index !== current.nextPage || !Array.isArray(record.rows)) throw new Error("备份分页记录无效");
      const rows = record.rows as Array<Record<string, unknown>>;
      const columnNames = current.columns.map((column) => column.name).sort();
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row) || canonicalJson(Object.keys(row).sort()) !== canonicalJson(columnNames)) throw new Error(`${current.name} 行列不完整`);
        rowValues(row, current.columns);
      }
      current.sha256 = await nextBackupDigest(current.sha256, current.nextPage, rows as BackupRow[]);
      current.rowCount += rows.length; current.nextPage += 1; continue;
    }
    if (record.type === "table_end") {
      if (phase !== "page" || !current || record.name !== current.name || record.rowCount !== current.rowCount || record.sha256 !== current.sha256) throw new Error("逐表行数或 SHA-256 校验失败");
      tables.push({ name: current.name, rowCount: current.rowCount, sha256: current.sha256, primaryKey: primaryKey(current.columns) });
      current = null; expectedTableIndex += 1;
      phase = expectedTableIndex === BUSINESS_TABLES.length ? "footer" : "table"; continue;
    }
    if (record.type === "footer") {
      if (phase !== "footer" || current) throw new Error("备份完成标记位置无效");
      footer = record as unknown as FooterRecord;
      if (!footer.complete || footer.consistency !== "d1-bookmark-and-double-scan" || footer.startBookmark !== startBookmark || footer.endBookmark < startBookmark) throw new Error("备份期间源数据库发生变化，文件不可用于恢复演练");
      const totalRows = tables.reduce((sum, table) => sum + table.rowCount, 0);
      const sha256 = await backupManifestDigest(tables);
      if (footer.tableCount !== 25 || footer.totalRows !== totalRows || footer.sha256 !== sha256 || canonicalJson(footer.tables) !== canonicalJson(tables)) throw new Error("总清单 SHA-256 校验失败");
      phase = "done"; continue;
    }
    throw new Error("备份包含未知记录");
  }
  if (phase !== "done" || !footer || tables.length !== 25) throw new Error("备份不完整或缺少有效完成标记");
  return { valid: true as const, tableCount: 25 as const, totalRows: footer.totalRows, sha256: footer.sha256, tables, queryCount: targetSchemas ? 1 : 0 };
}

export function backupFileName(createdAt = new Date().toISOString()) {
  return `tg-content-toolbox-site-v26-d1-v30-${createdAt.replace(/[:.]/g, "-")}.ndjson`;
}

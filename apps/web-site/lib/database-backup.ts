import { getD1 } from "../db";
import { sha256Hex } from "./security";

export const DATABASE_BACKUP_FORMAT = "tg-content-toolbox-d1-backup-ndjson/v2";
export const DATABASE_BACKUP_SITE_VERSION = 26;
export const DATABASE_BACKUP_CANDIDATE_SITE_VERSION = 28;
export const DATABASE_BACKUP_SOURCE_COMMIT = "124e80b491eb4b7a3dee5f3e8eb44aeffc317f9e";
export const DATABASE_BACKUP_SOURCE_TREE = "13c743aa695e1b4dde953c993a1bc8517edb8090";

export const BUSINESS_TABLES = [
  "app_logs",
  "app_settings",
  "content_results",
  "content_runs",
  "data_snapshot_items",
  "data_snapshots",
  "import_batch_chunks",
  "import_batches",
  "import_changes",
  "input_sources",
  "permanent_records",
  "script_generations",
  "sync_transactions",
  "task_inbox",
  "telegram_accounts",
  "telegram_auth_flows",
  "telegram_bot_state",
  "telegram_connections",
  "telegram_message_fingerprints",
  "telegram_messages",
  "telegram_migration_runs",
  "telegram_read_states",
  "telegram_sync_runs",
  "telegram_tool_queue",
  "tool_source_bindings",
] as const;

export type BusinessTable = (typeof BUSINESS_TABLES)[number];
type BackupValue = string | number | null;
type BackupRow = Record<string, BackupValue>;
export type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};
export type BackupManifestEntry = {
  name: BusinessTable;
  rowCount: number;
  sha256: string;
  primaryKey: string[];
};
export type DatabaseInventory = {
  inspectedAt: string;
  source: ReturnType<typeof backupSource>;
  security: ReturnType<typeof backupSecurity>;
  tableCount: 25;
  totalRows: number;
  tables: Array<Omit<BackupManifestEntry, "sha256">>;
};

type HeaderRecord = {
  type: "header";
  format: typeof DATABASE_BACKUP_FORMAT;
  createdAt: string;
  source: ReturnType<typeof backupSource>;
  security: ReturnType<typeof backupSecurity>;
  tableCount: 25;
  pageSize: number;
  hashAlgorithm: "SHA-256 chained canonical pages";
};
type TableRecord = { type: "table"; name: BusinessTable; columns: ColumnInfo[]; primaryKey: string[] };
type PageRecord = { type: "page"; table: BusinessTable; index: number; rows: BackupRow[] };
type TableEndRecord = { type: "table_end"; name: BusinessTable; rowCount: number; sha256: string };
type FooterRecord = {
  type: "footer";
  complete: boolean;
  tableCount: number;
  totalRows: number;
  sha256: string;
  tables: BackupManifestEntry[];
  consistency: "double-scan-match";
  error?: "source_changed_during_backup";
};
type BackupRecord = HeaderRecord | TableRecord | PageRecord | TableEndRecord | FooterRecord;

const TABLE_SET = new Set<string>(BUSINESS_TABLES);
const PAGE_SIZE = 250;
const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;
const INITIAL_DIGEST = "0".repeat(64);

function backupSource() {
  return {
    site: "TG 内容工具箱" as const,
    siteVersion: DATABASE_BACKUP_SITE_VERSION,
    candidateSiteVersion: DATABASE_BACKUP_CANDIDATE_SITE_VERSION,
    commit: DATABASE_BACKUP_SOURCE_COMMIT,
    tree: DATABASE_BACKUP_SOURCE_TREE,
    database: "formal-sites-d1" as const,
  };
}

function backupSecurity() {
  return {
    telegramSession: "opaque-encrypted-ciphertext" as const,
    decrypted: false as const,
    displayed: false as const,
  };
}

function quoteIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`不安全数据库标识符：${value}`);
  return `"${value}"`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
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

async function tableColumns(db: D1Database, table: BusinessTable): Promise<ColumnInfo[]> {
  const result = await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<ColumnInfo>();
  const columns = (result.results ?? []).map((column) => ({
    name: String(column.name),
    type: String(column.type || ""),
    notnull: Number(column.notnull || 0),
    pk: Number(column.pk || 0),
  }));
  if (!columns.length) throw new Error(`正式 D1 缺少业务表 ${table}`);
  return columns;
}

function primaryKey(columns: ColumnInfo[]) {
  return columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name);
}

function orderExpression(columns: ColumnInfo[]) {
  const keys = primaryKey(columns);
  return (keys.length ? keys : columns.map((column) => column.name)).map(quoteIdentifier).join(",");
}

async function tableRowCount(db: D1Database, table: BusinessTable) {
  const result = await db.prepare(`SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(table)}`).first<{ row_count: number }>();
  return Number(result?.row_count ?? 0);
}

export async function listDatabaseTables(db: D1Database = getD1()): Promise<DatabaseInventory> {
  const tables: DatabaseInventory["tables"] = [];
  for (const name of BUSINESS_TABLES) {
    const columns = await tableColumns(db, name);
    tables.push({ name, rowCount: await tableRowCount(db, name), primaryKey: primaryKey(columns) });
  }
  return {
    inspectedAt: new Date().toISOString(),
    source: backupSource(),
    security: backupSecurity(),
    tableCount: 25,
    totalRows: tables.reduce((sum, table) => sum + table.rowCount, 0),
    tables,
  };
}

async function* readTablePages(db: D1Database, table: BusinessTable, columns: ColumnInfo[]) {
  const orderBy = orderExpression(columns);
  for (let offset = 0, index = 0; ; offset += PAGE_SIZE, index += 1) {
    const result = await db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(PAGE_SIZE, offset)
      .all<Record<string, unknown>>();
    const rows = (result.results ?? []).map((row) => rowValues(row, columns));
    if (rows.length) yield { index, rows };
    if (rows.length < PAGE_SIZE) break;
  }
}

async function nextDigest(current: string, index: number, rows: BackupRow[]) {
  return sha256Hex(`${current}\n${index}\n${canonical(rows)}`);
}

async function scanTable(db: D1Database, name: BusinessTable, columns: ColumnInfo[]) {
  let rowCount = 0;
  let sha256 = INITIAL_DIGEST;
  for await (const page of readTablePages(db, name, columns)) {
    rowCount += page.rows.length;
    sha256 = await nextDigest(sha256, page.index, page.rows);
  }
  return { name, rowCount, sha256, primaryKey: primaryKey(columns) } satisfies BackupManifestEntry;
}

async function* backupRecords(db: D1Database): AsyncGenerator<BackupRecord> {
  const createdAt = new Date().toISOString();
  yield {
    type: "header",
    format: DATABASE_BACKUP_FORMAT,
    createdAt,
    source: backupSource(),
    security: backupSecurity(),
    tableCount: 25,
    pageSize: PAGE_SIZE,
    hashAlgorithm: "SHA-256 chained canonical pages",
  };

  const firstPass: BackupManifestEntry[] = [];
  const schemas = new Map<BusinessTable, ColumnInfo[]>();
  for (const name of BUSINESS_TABLES) {
    const columns = await tableColumns(db, name);
    schemas.set(name, columns);
    yield { type: "table", name, columns, primaryKey: primaryKey(columns) };
    let rowCount = 0;
    let sha256 = INITIAL_DIGEST;
    for await (const page of readTablePages(db, name, columns)) {
      rowCount += page.rows.length;
      sha256 = await nextDigest(sha256, page.index, page.rows);
      yield { type: "page", table: name, index: page.index, rows: page.rows };
    }
    firstPass.push({ name, rowCount, sha256, primaryKey: primaryKey(columns) });
    yield { type: "table_end", name, rowCount, sha256 };
  }

  let consistent = true;
  for (const expected of firstPass) {
    const currentColumns = await tableColumns(db, expected.name);
    if (canonical(currentColumns) !== canonical(schemas.get(expected.name))) {
      consistent = false;
      break;
    }
    const actual = await scanTable(db, expected.name, currentColumns);
    if (actual.rowCount !== expected.rowCount || actual.sha256 !== expected.sha256) {
      consistent = false;
      break;
    }
  }
  const totalRows = firstPass.reduce((sum, table) => sum + table.rowCount, 0);
  yield {
    type: "footer",
    complete: consistent,
    tableCount: firstPass.length,
    totalRows,
    sha256: await sha256Hex(canonical(firstPass)),
    tables: firstPass,
    consistency: "double-scan-match",
    ...(consistent ? {} : { error: "source_changed_during_backup" as const }),
  };
}

export function createDatabaseBackupStream(db: D1Database = getD1()) {
  const records = backupRecords(db)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const record = await records.next();
        if (record.done) return controller.close();
        controller.enqueue(encoder.encode(`${JSON.stringify(record.value)}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await records.return?.(undefined);
    },
  });
}

async function* readNdjson(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (new TextEncoder().encode(buffer).byteLength > MAX_NDJSON_LINE_BYTES && !buffer.includes("\n")) throw new Error("备份记录超过单行大小上限");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          if (new TextEncoder().encode(line).byteLength > MAX_NDJSON_LINE_BYTES) throw new Error("备份记录超过单行大小上限");
          yield JSON.parse(line) as Record<string, unknown>;
        }
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      if (new TextEncoder().encode(buffer).byteLength > MAX_NDJSON_LINE_BYTES) throw new Error("备份记录超过单行大小上限");
      yield JSON.parse(buffer) as Record<string, unknown>;
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("备份 NDJSON 内容无法解析");
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function assertHeader(record: Record<string, unknown>) {
  if (record.format !== DATABASE_BACKUP_FORMAT) throw new Error("备份格式或版本不受支持");
  const source = record.source as HeaderRecord["source"] | undefined;
  const security = record.security as HeaderRecord["security"] | undefined;
  if (source?.site !== "TG 内容工具箱" || source.siteVersion !== DATABASE_BACKUP_SITE_VERSION) throw new Error("备份来源不是 TG 内容工具箱 Site v26");
  if (security?.telegramSession !== "opaque-encrypted-ciphertext" || security.decrypted !== false || security.displayed !== false) {
    throw new Error("Telegram Session 安全声明缺失");
  }
  if (record.tableCount !== 25) throw new Error("备份必须包含完整 25 张业务表");
}

export async function validateDatabaseBackupStream(stream: ReadableStream<Uint8Array> | null, db?: D1Database) {
  if (!stream) throw new Error("备份文件为空");
  let phase: "header" | "table" | "page" | "footer" | "done" = "header";
  let expectedTableIndex = 0;
  let current: { name: BusinessTable; columns: ColumnInfo[]; nextPage: number; rowCount: number; sha256: string } | null = null;
  const tables: BackupManifestEntry[] = [];
  let footer: FooterRecord | null = null;

  for await (const record of readNdjson(stream)) {
    if (phase === "header") {
      if (record.type !== "header") throw new Error("备份缺少头记录");
      assertHeader(record);
      phase = "table";
      continue;
    }
    if (phase === "done") throw new Error("备份完成标记后仍有多余内容");
    if (record.type === "table") {
      if (phase !== "table" || current) throw new Error("备份表记录顺序无效");
      const name = String(record.name) as BusinessTable;
      if (!TABLE_SET.has(name) || name !== BUSINESS_TABLES[expectedTableIndex]) throw new Error("备份表清单或顺序与正式 25 表不一致");
      const columns = record.columns as ColumnInfo[];
      if (!Array.isArray(columns) || !columns.length || new Set(columns.map((column) => column.name)).size !== columns.length) throw new Error(`${name} 列定义无效`);
      if (db && canonical(await tableColumns(db, name)) !== canonical(columns)) throw new Error(`${name} 与目标 D1 Schema 不一致`);
      current = { name, columns, nextPage: 0, rowCount: 0, sha256: INITIAL_DIGEST };
      phase = "page";
      continue;
    }
    if (record.type === "page") {
      if (phase !== "page" || !current || record.table !== current.name || record.index !== current.nextPage || !Array.isArray(record.rows)) throw new Error("备份分页记录无效");
      const rows = record.rows as Array<Record<string, unknown>>;
      const columnNames = current.columns.map((column) => column.name).sort();
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row) || canonical(Object.keys(row).sort()) !== canonical(columnNames)) throw new Error(`${current.name} 行列不完整`);
        rowValues(row, current.columns);
      }
      current.sha256 = await nextDigest(current.sha256, current.nextPage, rows as BackupRow[]);
      current.rowCount += rows.length;
      current.nextPage += 1;
      continue;
    }
    if (record.type === "table_end") {
      if (phase !== "page" || !current || record.name !== current.name || record.rowCount !== current.rowCount || record.sha256 !== current.sha256) throw new Error("逐表行数或 SHA-256 校验失败");
      tables.push({ name: current.name, rowCount: current.rowCount, sha256: current.sha256, primaryKey: primaryKey(current.columns) });
      current = null;
      expectedTableIndex += 1;
      phase = expectedTableIndex === BUSINESS_TABLES.length ? "footer" : "table";
      continue;
    }
    if (record.type === "footer") {
      if (phase !== "footer" || current) throw new Error("备份完成标记位置无效");
      footer = record as unknown as FooterRecord;
      if (!footer.complete || footer.consistency !== "double-scan-match") throw new Error("备份期间源数据库发生变化，文件不可用于恢复演练");
      const totalRows = tables.reduce((sum, table) => sum + table.rowCount, 0);
      const sha256 = await sha256Hex(canonical(tables));
      if (footer.tableCount !== 25 || footer.totalRows !== totalRows || footer.sha256 !== sha256 || canonical(footer.tables) !== canonical(tables)) throw new Error("总清单 SHA-256 校验失败");
      phase = "done";
      continue;
    }
    throw new Error("备份包含未知记录");
  }
  if (phase !== "done" || !footer || tables.length !== 25) throw new Error("备份不完整或缺少有效完成标记");
  return { valid: true as const, tableCount: 25 as const, totalRows: footer.totalRows, sha256: footer.sha256, tables };
}

export function backupFileName(createdAt = new Date().toISOString()) {
  return `tg-content-toolbox-site-v26-d1-${createdAt.replace(/[:.]/g, "-")}.ndjson`;
}

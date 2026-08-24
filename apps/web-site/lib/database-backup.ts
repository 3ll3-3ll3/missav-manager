import { getD1 } from "../db";
import { sha256Hex } from "./security";

export const DATABASE_BACKUP_FORMAT = "tg-content-toolbox-d1-backup/v1";
export const DATABASE_BACKUP_SITE_VERSION = 26;
export const DATABASE_BACKUP_SOURCE_COMMIT = "124e80b491eb4b7a3dee5f3e8eb44aeffc317f9e";
export const DATABASE_BACKUP_SOURCE_TREE = "13c743aa695e1b4dde953c993a1bc8517edb8090";
export const RESTORE_CONFIRMATION = "RESTORE 25 TABLES";

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
type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};
type BackupTable = {
  name: BusinessTable;
  columns: ColumnInfo[];
  rowCount: number;
  sha256: string;
  rows: BackupRow[];
};
export type BackupManifestEntry = Omit<BackupTable, "rows" | "columns"> & {
  primaryKey: string[];
};
export type DatabaseBackup = {
  format: typeof DATABASE_BACKUP_FORMAT;
  createdAt: string;
  source: {
    site: "TG 内容工具箱";
    siteVersion: typeof DATABASE_BACKUP_SITE_VERSION;
    commit: typeof DATABASE_BACKUP_SOURCE_COMMIT;
    tree: typeof DATABASE_BACKUP_SOURCE_TREE;
    database: "formal-sites-d1";
  };
  security: {
    telegramSession: "opaque-encrypted-ciphertext";
    decrypted: false;
    displayed: false;
  };
  manifest: {
    tableCount: 25;
    totalRows: number;
    sha256: string;
    tables: BackupManifestEntry[];
  };
  tables: BackupTable[];
};

const TABLE_SET = new Set<string>(BUSINESS_TABLES);
const PAGE_SIZE = 1_000;
const BATCH_SIZE = 80;

const INSERT_ORDER: BusinessTable[] = [
  "app_settings",
  "app_logs",
  "content_runs",
  "permanent_records",
  "input_sources",
  "telegram_connections",
  "telegram_accounts",
  "telegram_auth_flows",
  "telegram_migration_runs",
  "data_snapshots",
  "import_batches",
  "sync_transactions",
  "task_inbox",
  "script_generations",
  "content_results",
  "tool_source_bindings",
  "telegram_messages",
  "telegram_message_fingerprints",
  "telegram_read_states",
  "telegram_sync_runs",
  "telegram_bot_state",
  "telegram_tool_queue",
  "data_snapshot_items",
  "import_changes",
  "import_batch_chunks",
];

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

async function readTable(db: D1Database, table: BusinessTable): Promise<BackupTable> {
  const columns = await tableColumns(db, table);
  const rows: BackupRow[] = [];
  const orderBy = orderExpression(columns);
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(PAGE_SIZE, offset)
      .all<Record<string, unknown>>();
    const page = (result.results ?? []).map((row) => rowValues(row, columns));
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return {
    name: table,
    columns,
    rowCount: rows.length,
    sha256: await sha256Hex(canonical(rows)),
    rows,
  };
}

export async function createDatabaseBackup(db: D1Database = getD1()): Promise<DatabaseBackup> {
  const tables: BackupTable[] = [];
  for (const table of BUSINESS_TABLES) tables.push(await readTable(db, table));
  const manifestTables: BackupManifestEntry[] = tables.map((table) => ({
    name: table.name,
    rowCount: table.rowCount,
    sha256: table.sha256,
    primaryKey: primaryKey(table.columns),
  }));
  const totalRows = manifestTables.reduce((sum, table) => sum + table.rowCount, 0);
  return {
    format: DATABASE_BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    source: {
      site: "TG 内容工具箱",
      siteVersion: DATABASE_BACKUP_SITE_VERSION,
      commit: DATABASE_BACKUP_SOURCE_COMMIT,
      tree: DATABASE_BACKUP_SOURCE_TREE,
      database: "formal-sites-d1",
    },
    security: {
      telegramSession: "opaque-encrypted-ciphertext",
      decrypted: false,
      displayed: false,
    },
    manifest: {
      tableCount: 25,
      totalRows,
      sha256: await sha256Hex(canonical(manifestTables)),
      tables: manifestTables,
    },
    tables,
  };
}

function parseBackup(input: unknown): DatabaseBackup {
  if (!input || typeof input !== "object") throw new Error("备份文件不是 JSON 对象");
  return input as DatabaseBackup;
}

export async function validateDatabaseBackup(input: unknown, db?: D1Database) {
  const backup = parseBackup(input);
  if (backup.format !== DATABASE_BACKUP_FORMAT) throw new Error("备份格式或版本不受支持");
  if (backup.source?.site !== "TG 内容工具箱" || backup.source?.siteVersion !== DATABASE_BACKUP_SITE_VERSION) throw new Error("备份来源不是 TG 内容工具箱 Site v26");
  if (!Array.isArray(backup.tables) || backup.tables.length !== BUSINESS_TABLES.length) throw new Error("备份必须包含完整 25 张业务表");
  if (backup.security?.telegramSession !== "opaque-encrypted-ciphertext" || backup.security?.decrypted !== false || backup.security?.displayed !== false) {
    throw new Error("Telegram Session 安全声明缺失");
  }
  const names = backup.tables.map((table) => String(table.name));
  if (new Set(names).size !== BUSINESS_TABLES.length || names.some((name) => !TABLE_SET.has(name))) throw new Error("备份表清单与正式 25 表不一致");
  const manifestEntries: BackupManifestEntry[] = [];
  for (const tableName of BUSINESS_TABLES) {
    const table = backup.tables.find((candidate) => candidate.name === tableName);
    if (!table || !Array.isArray(table.rows) || !Array.isArray(table.columns)) throw new Error(`${tableName} 数据结构无效`);
    const columnNames = table.columns.map((column) => String(column.name));
    if (!columnNames.length || new Set(columnNames).size !== columnNames.length) throw new Error(`${tableName} 列定义无效`);
    for (const row of table.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${tableName} 包含无效行`);
      const rowNames = Object.keys(row).sort();
      if (canonical(rowNames) !== canonical([...columnNames].sort())) throw new Error(`${tableName} 行列不完整`);
      rowValues(row, table.columns);
    }
    const digest = await sha256Hex(canonical(table.rows));
    if (table.rowCount !== table.rows.length || table.sha256 !== digest) throw new Error(`${tableName} 行数或 SHA-256 校验失败`);
    if (db) {
      const actualColumns = await tableColumns(db, tableName);
      if (canonical(actualColumns) !== canonical(table.columns)) throw new Error(`${tableName} 与目标 D1 Schema 不一致`);
    }
    manifestEntries.push({ name: tableName, rowCount: table.rowCount, sha256: digest, primaryKey: primaryKey(table.columns) });
  }
  const totalRows = manifestEntries.reduce((sum, table) => sum + table.rowCount, 0);
  const manifestHash = await sha256Hex(canonical(manifestEntries));
  if (backup.manifest?.tableCount !== 25 || backup.manifest?.totalRows !== totalRows || backup.manifest?.sha256 !== manifestHash || canonical(backup.manifest.tables) !== canonical(manifestEntries)) {
    throw new Error("总清单 SHA-256 校验失败");
  }
  return { valid: true as const, tableCount: 25, totalRows, sha256: manifestHash, tables: manifestEntries };
}

export async function restoreDatabaseBackup(input: unknown, confirmation: unknown, db: D1Database = getD1()) {
  if (confirmation !== RESTORE_CONFIRMATION) throw new Error(`恢复确认文本必须为 ${RESTORE_CONFIRMATION}`);
  const validation = await validateDatabaseBackup(input, db);
  const backup = input as DatabaseBackup;
  for (const table of [...INSERT_ORDER].reverse()) await db.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
  for (const tableName of INSERT_ORDER) {
    const table = backup.tables.find((candidate) => candidate.name === tableName)!;
    const names = table.columns.map((column) => column.name);
    const sql = `INSERT INTO ${quoteIdentifier(tableName)} (${names.map(quoteIdentifier).join(",")}) VALUES (${names.map(() => "?").join(",")})`;
    for (let index = 0; index < table.rows.length; index += BATCH_SIZE) {
      const statements = table.rows.slice(index, index + BATCH_SIZE).map((row) => db.prepare(sql).bind(...names.map((name) => row[name])));
      await db.batch(statements);
    }
  }
  const verified = await createDatabaseBackup(db);
  const after = await validateDatabaseBackup(verified, db);
  if (after.sha256 !== validation.sha256 || after.totalRows !== validation.totalRows) throw new Error("恢复后完整性复核失败");
  return { restored: true as const, tableCount: after.tableCount, totalRows: after.totalRows, sha256: after.sha256 };
}

export function backupFileName(createdAt: string) {
  return `tg-content-toolbox-site-v26-d1-${createdAt.replace(/[:.]/g, "-")}.json`;
}

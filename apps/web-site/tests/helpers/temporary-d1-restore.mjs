const INSERT_ORDER = [
  "app_settings", "app_logs", "content_runs", "permanent_records", "input_sources",
  "telegram_connections", "telegram_accounts", "telegram_auth_flows", "telegram_migration_runs",
  "data_snapshots", "import_batches", "sync_transactions", "task_inbox", "script_generations",
  "content_results", "tool_source_bindings", "telegram_messages", "telegram_message_fingerprints",
  "telegram_read_states", "telegram_sync_runs", "telegram_bot_state", "telegram_tool_queue",
  "data_snapshot_items", "import_changes", "import_batch_chunks",
];

function quote(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("unsafe identifier");
  return `"${value}"`;
}

export async function restoreBackupIntoFreshTemporaryD1({ text, db, backupModule }) {
  await backupModule.validateDatabaseBackupStream(new Blob([text]).stream(), db);
  for (const table of backupModule.BUSINESS_TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS row_count FROM ${quote(table)}`).first();
    if (Number(row?.row_count ?? 0) !== 0) throw new Error("temporary D1 must be fresh and empty");
  }

  const schemas = new Map();
  const rows = new Map(backupModule.BUSINESS_TABLES.map((table) => [table, []]));
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === "table") schemas.set(record.name, record.columns.map((column) => column.name));
    if (record.type === "page") rows.get(record.table).push(...record.rows);
  }

  for (const table of INSERT_ORDER) {
    const columns = schemas.get(table);
    const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
    const tableRows = rows.get(table);
    for (let index = 0; index < tableRows.length; index += 80) {
      await db.batch(tableRows.slice(index, index + 80).map((row) => db.prepare(sql).bind(...columns.map((column) => row[column]))));
    }
  }
  return backupModule.validateDatabaseBackupStream(new Blob([text]).stream(), db);
}

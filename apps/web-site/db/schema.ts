import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const contentRuns = sqliteTable("content_runs", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),
  name: text("name").notNull(),
  inputKind: text("input_kind").notNull(),
  startAt: text("start_at").notNull().default(""),
  endAt: text("end_at").notNull().default(""),
  sourceSummary: text("source_summary").notNull().default(""),
  totalCount: integer("total_count").notNull().default(0),
  resultCount: integer("result_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("content_runs_tool_created_idx").on(table.tool, table.createdAt)]);

export const contentResults = sqliteTable("content_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => contentRuns.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  resultKey: text("result_key").notNull(),
  primaryValue: text("primary_value").notNull(),
  secondaryValue: text("secondary_value").notNull().default(""),
  status: text("status").notNull().default("success"),
  tagsJson: text("tags_json").notNull().default("[]"),
  source: text("source").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("content_results_run_key_uq").on(table.runId, table.resultKey),
  index("content_results_run_idx").on(table.runId, table.createdAt),
]);

export const permanentRecords = sqliteTable("permanent_records", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),
  recordKey: text("record_key").notNull(),
  primaryValue: text("primary_value").notNull(),
  secondaryValue: text("secondary_value").notNull().default(""),
  status: text("status").notNull().default("new"),
  tagsJson: text("tags_json").notNull().default("[]"),
  actressTagsJson: text("actress_tags_json").notNull().default("[]"),
  genreTagsJson: text("genre_tags_json").notNull().default("[]"),
  sourceUrl: text("source_url").notNull().default(""),
  missavUrl: text("missav_url").notNull().default(""),
  av123Url: text("av123_url").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("permanent_records_tool_key_uq").on(table.tool, table.recordKey),
  index("permanent_records_tool_status_idx").on(table.tool, table.status, table.updatedAt),
  index("permanent_records_updated_idx").on(table.updatedAt),
]);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  checksum: text("checksum").notNull().default(""),
  status: text("status").notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  appliedRows: integer("applied_rows").notNull().default(0),
  countsJson: text("counts_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("import_batches_created_idx").on(table.createdAt)]);

export const importChanges = sqliteTable("import_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  recordKey: text("record_key").notNull(),
  action: text("action").notNull(),
  previousJson: text("previous_json").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("import_changes_batch_record_uq").on(table.batchId, table.tool, table.recordKey),
  index("import_changes_batch_idx").on(table.batchId, table.id),
]);

export const importBatchChunks = sqliteTable("import_batch_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  checksum: text("checksum").notNull(),
  rowCount: integer("row_count").notNull(),
  appliedCount: integer("applied_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("import_batch_chunks_batch_index_uq").on(table.batchId, table.chunkIndex),
  index("import_batch_chunks_batch_idx").on(table.batchId, table.id),
]);

export const inputSources = sqliteTable("input_sources", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  externalKey: text("external_key").notNull(),
  name: text("name").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("input_sources_kind_external_uq").on(table.kind, table.externalKey)]);

export const toolSourceBindings = sqliteTable("tool_source_bindings", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => inputSources.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("tool_source_bindings_source_tool_uq").on(table.sourceId, table.tool)]);

export const telegramMessages = sqliteTable("telegram_messages", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => inputSources.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  messageDate: text("message_date").notNull().default(""),
  body: text("body").notNull().default(""),
  bodyDeletedAt: text("body_deleted_at").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("telegram_messages_source_message_uq").on(table.sourceId, table.messageId),
  index("telegram_messages_date_idx").on(table.messageDate, table.id),
]);

export const telegramToolQueue = sqliteTable("telegram_tool_queue", {
  id: text("id").primaryKey(),
  telegramMessageId: text("telegram_message_id").notNull().references(() => telegramMessages.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  status: text("status").notNull().default("pending"),
  candidateCount: integer("candidate_count").notNull().default(0),
  runId: text("run_id").notNull().default(""),
  processedAt: text("processed_at").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("telegram_tool_queue_message_tool_uq").on(table.telegramMessageId, table.tool),
  index("telegram_tool_queue_tool_status_idx").on(table.tool, table.status, table.updatedAt),
]);

export const telegramMessageFingerprints = sqliteTable("telegram_message_fingerprints", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => inputSources.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("telegram_message_fingerprints_source_message_uq").on(table.sourceId, table.messageId)]);

export const syncTransactions = sqliteTable("sync_transactions", {
  id: text("id").primaryKey(),
  sourceKind: text("source_kind").notNull(),
  status: text("status").notNull(),
  receivedCount: integer("received_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  queueCount: integer("queue_count").notNull().default(0),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("sync_transactions_created_idx").on(table.createdAt)]);

export const taskInbox = sqliteTable("task_inbox", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),
  stage: text("stage").notNull(),
  title: text("title").notNull(),
  runId: text("run_id").notNull().default(""),
  recordId: text("record_id").notNull().default(""),
  sourceId: text("source_id").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("task_inbox_stage_updated_idx").on(table.stage, table.updatedAt)]);

export const scriptGenerations = sqliteTable("script_generations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().default(""),
  templateHash: text("template_hash").notNull(),
  codeCount: integer("code_count").notNull(),
  referenceTagCount: integer("reference_tag_count").notNull(),
  referenceBlacklistCount: integer("reference_blacklist_count").notNull(),
  exportBlacklistCount: integer("export_blacklist_count").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("script_generations_created_idx").on(table.createdAt)]);

export const appLogs = sqliteTable("app_logs", {
  id: text("id").primaryKey(),
  level: text("level").notNull(),
  category: text("category").notNull(),
  message: text("message").notNull(),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("app_logs_level_created_idx").on(table.level, table.createdAt)]);

export const dataSnapshots = sqliteTable("data_snapshots", {
  id: text("id").primaryKey(),
  reason: text("reason").notNull(),
  entity: text("entity").notNull(),
  itemCount: integer("item_count").notNull().default(0),
  status: text("status").notNull().default("ready"),
  createdAt: text("created_at").notNull(),
  restoredAt: text("restored_at").notNull().default(""),
}, (table) => [index("data_snapshots_created_idx").on(table.createdAt)]);

export const dataSnapshotItems = sqliteTable("data_snapshot_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: text("snapshot_id").notNull().references(() => dataSnapshots.id, { onDelete: "cascade" }),
  entityKey: text("entity_key").notNull(),
  previousJson: text("previous_json").notNull(),
}, (table) => [index("data_snapshot_items_snapshot_idx").on(table.snapshotId, table.id)]);

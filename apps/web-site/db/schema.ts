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

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
  connectionId: text("connection_id").notNull().default(""),
  externalChatId: text("external_chat_id").notNull().default(""),
  chatType: text("chat_type").notNull().default(""),
  username: text("username").notNull().default(""),
  accessStatus: text("access_status").notNull().default("unknown"),
  archived: integer("archived").notNull().default(0),
  lastSyncAt: text("last_sync_at").notNull().default(""),
  latestRemoteMessageId: text("latest_remote_message_id").notNull().default(""),
  incrementalCheckpointId: text("incremental_checkpoint_id").notNull().default(""),
  syncCursorMessageId: text("sync_cursor_message_id").notNull().default(""),
  syncTargetMessageId: text("sync_target_message_id").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  name: text("name").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("input_sources_kind_external_uq").on(table.kind, table.externalKey),
  uniqueIndex("input_sources_connection_chat_uq").on(table.connectionId, table.externalChatId),
  index("input_sources_connection_status_idx").on(table.connectionId, table.accessStatus, table.updatedAt),
]);

export const toolSourceBindings = sqliteTable("tool_source_bindings", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => inputSources.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  historyMode: text("history_mode").notNull().default("since_now"),
  historyLimit: integer("history_limit").notNull().default(0),
  historyFrom: text("history_from").notNull().default(""),
  boundAtMessageId: text("bound_at_message_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("tool_source_bindings_source_tool_uq").on(table.sourceId, table.tool)]);

export const telegramMessages = sqliteTable("telegram_messages", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => inputSources.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  connectionId: text("connection_id").notNull().default(""),
  externalMessageId: text("external_message_id").notNull().default(""),
  remoteUpdateId: text("remote_update_id").notNull().default(""),
  messageDate: text("message_date").notNull().default(""),
  body: text("body").notNull().default(""),
  eventKind: text("event_kind").notNull().default("message"),
  contentHash: text("content_hash").notNull().default(""),
  remoteEditedAt: text("remote_edited_at").notNull().default(""),
  remoteDeletedAt: text("remote_deleted_at").notNull().default(""),
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
  errorMessage: text("error_message").notNull().default(""),
  selectedAt: text("selected_at").notNull().default(""),
  processingAt: text("processing_at").notNull().default(""),
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
  contentHash: text("content_hash").notNull().default(""),
  eventKind: text("event_kind").notNull().default("message"),
  lastRemoteUpdateId: text("last_remote_update_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull().default(""),
}, (table) => [uniqueIndex("telegram_message_fingerprints_source_message_uq").on(table.sourceId, table.messageId)]);

export const telegramAccounts = sqliteTable("telegram_accounts", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("authorized"),
  encryptedSession: text("encrypted_session").notNull(),
  accountKey: text("account_key").notNull().default(""),
  accountLabel: text("account_label").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const telegramConnections = sqliteTable("telegram_connections", {
  connectionId: text("connection_id").primaryKey(),
  kind: text("kind").notNull(),
  label: text("label").notNull().default(""),
  status: text("status").notNull().default("disconnected"),
  accountKey: text("account_key").notNull().default(""),
  accountLabel: text("account_label").notNull().default(""),
  username: text("username").notNull().default(""),
  sessionEncrypted: text("session_encrypted").notNull().default(""),
  networkStatus: text("network_status").notNull().default("unknown"),
  lastConnectedAt: text("last_connected_at").notNull().default(""),
  lastSuccessAt: text("last_success_at").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("telegram_connections_kind_idx").on(table.kind, table.status)]);

export const telegramBotState = sqliteTable("telegram_bot_state", {
  connectionId: text("connection_id").primaryKey().references(() => telegramConnections.connectionId, { onDelete: "cascade" }),
  nextUpdateOffset: integer("next_update_offset").notNull().default(0),
  lastUpdateId: integer("last_update_id").notNull().default(0),
  lockUntil: text("lock_until").notNull().default(""),
  webhookStatus: text("webhook_status").notNull().default("unknown"),
  lastCheckedAt: text("last_checked_at").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const telegramReadStates = sqliteTable("telegram_read_states", {
  sourceId: text("source_id").primaryKey().references(() => inputSources.id, { onDelete: "cascade" }),
  policy: text("policy").notNull().default("never"),
  safeReadMessageId: text("safe_read_message_id").notNull().default(""),
  lastMarkedReadMessageId: text("last_marked_read_message_id").notNull().default(""),
  readBaselineMessageId: text("read_baseline_message_id").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const telegramSyncRuns = sqliteTable("telegram_sync_runs", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  sourceId: text("source_id").notNull().default(""),
  transport: text("transport").notNull(),
  mode: text("mode").notNull().default("incremental"),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at").notNull().default(""),
  scannedCount: integer("scanned_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  editedCount: integer("edited_count").notNull().default(0),
  deletedCount: integer("deleted_count").notNull().default(0),
  queueCount: integer("queue_count").notNull().default(0),
  hasMore: integer("has_more").notNull().default(0),
  emptyCandidateCount: integer("empty_candidate_count").notNull().default(0),
  checkpointBefore: text("checkpoint_before").notNull().default(""),
  checkpointAfter: text("checkpoint_after").notNull().default(""),
  readResult: text("read_result").notNull().default("not_attempted"),
  errorMessage: text("error_message").notNull().default(""),
  detailJson: text("detail_json").notNull().default("{}"),
}, (table) => [index("telegram_sync_runs_created_idx").on(table.startedAt, table.connectionId)]);

export const telegramMigrationRuns = sqliteTable("telegram_migration_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("preview"),
  snapshotId: text("snapshot_id").notNull().default(""),
  countsJson: text("counts_json").notNull().default("{}"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  appliedAt: text("applied_at").notNull().default(""),
});

export const telegramAuthFlows = sqliteTable("telegram_auth_flows", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  stage: text("stage").notNull(),
  encryptedSession: text("encrypted_session").notNull(),
  challengeJson: text("challenge_json").notNull().default("{}"),
  encryptedChallenge: text("encrypted_challenge").notNull().default(""),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("telegram_auth_flows_expires_idx").on(table.expiresAt)]);

export const syncTransactions = sqliteTable("sync_transactions", {
  id: text("id").primaryKey(),
  sourceKind: text("source_kind").notNull(),
  status: text("status").notNull(),
  receivedCount: integer("received_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  editedCount: integer("edited_count").notNull().default(0),
  deletedCount: integer("deleted_count").notNull().default(0),
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

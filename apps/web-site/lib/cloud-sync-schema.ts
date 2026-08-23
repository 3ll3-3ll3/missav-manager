const runtimeAllowsOutbox =
  "COALESCE((SELECT suppress_outbox FROM cloud_sync_runtime WHERE id=1),0)=0";

function triggerSet(
  table: string,
  rowKeyNew: string,
  rowKeyOld: string,
  jsonNew: string,
  jsonOld: string,
  extraWhen = "1=1",
  changedAtNew = "COALESCE(NULLIF(NEW.updated_at,''),NULLIF(NEW.created_at,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
) {
  const safeName = table.replaceAll("_", "");
  return [
    `CREATE TRIGGER IF NOT EXISTS cloud_sync_${safeName}_insert AFTER INSERT ON ${table}
     WHEN ${runtimeAllowsOutbox} AND ${extraWhen.replaceAll("ROW.", "NEW.")}
     BEGIN
       INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
       VALUES('${table}',${rowKeyNew},'upsert',${jsonNew},${changedAtNew});
     END`,
    `CREATE TRIGGER IF NOT EXISTS cloud_sync_${safeName}_update AFTER UPDATE ON ${table}
     WHEN ${runtimeAllowsOutbox} AND ${extraWhen.replaceAll("ROW.", "NEW.")}
     BEGIN
       INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
       VALUES('${table}',${rowKeyNew},'upsert',${jsonNew},${changedAtNew});
     END`,
    `CREATE TRIGGER IF NOT EXISTS cloud_sync_${safeName}_delete AFTER DELETE ON ${table}
     WHEN ${runtimeAllowsOutbox} AND ${extraWhen.replaceAll("ROW.", "OLD.")}
     BEGIN
       INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
       VALUES('${table}',${rowKeyOld},'delete',${jsonOld},strftime('%Y-%m-%dT%H:%M:%fZ','now'));
     END`,
  ];
}

const permanentRecordJson = (row: string) => `json_object(
  'id',${row}.id,'tool',${row}.tool,'recordKey',${row}.record_key,
  'primaryValue',${row}.primary_value,'secondaryValue',${row}.secondary_value,
  'status',${row}.status,'tagsJson',${row}.tags_json,
  'actressTagsJson',${row}.actress_tags_json,'genreTagsJson',${row}.genre_tags_json,
  'sourceUrl',${row}.source_url,'missavUrl',${row}.missav_url,'av123Url',${row}.av123_url,
  'metadataJson',${row}.metadata_json,'createdAt',${row}.created_at,'updatedAt',${row}.updated_at)`;

const contentRunJson = (row: string) => `json_object(
  'id',${row}.id,'tool',${row}.tool,'name',${row}.name,'inputKind',${row}.input_kind,
  'startAt',${row}.start_at,'endAt',${row}.end_at,'sourceSummary',${row}.source_summary,
  'status',${row}.status,'statsJson',${row}.stats_json,'optionsJson',${row}.options_json,
  'totalCount',${row}.total_count,'resultCount',${row}.result_count,'errorCount',${row}.error_count,
  'createdAt',${row}.created_at,'updatedAt',${row}.updated_at)`;

const contentResultJson = (row: string) => `json_object(
  'id',${row}.id,'runId',${row}.run_id,'tool',${row}.tool,'resultKey',${row}.result_key,
  'primaryValue',${row}.primary_value,'secondaryValue',${row}.secondary_value,
  'status',${row}.status,'errorMessage',${row}.error_message,'tagsJson',${row}.tags_json,
  'source',${row}.source,'metadataJson',${row}.metadata_json,
  'createdAt',${row}.created_at,'updatedAt',${row}.updated_at)`;

const sourceJson = (row: string) => `json_object(
  'id',${row}.id,'kind',${row}.kind,'externalKey',${row}.external_key,
  'connectionId',${row}.connection_id,'externalChatId',${row}.external_chat_id,
  'chatType',${row}.chat_type,'username',${row}.username,'accessStatus',${row}.access_status,
  'archived',${row}.archived,'lastSyncAt',${row}.last_sync_at,
  'latestRemoteMessageId',${row}.latest_remote_message_id,
  'incrementalCheckpointId',${row}.incremental_checkpoint_id,
  'syncCursorMessageId',${row}.sync_cursor_message_id,'syncTargetMessageId',${row}.sync_target_message_id,
  'lastError',${row}.last_error,'name',${row}.name,'metadataJson',${row}.metadata_json,
  'createdAt',${row}.created_at,'updatedAt',${row}.updated_at)`;

const bindingJson = (row: string) => `json_object(
  'id',${row}.id,'sourceId',${row}.source_id,'tool',${row}.tool,
  'historyMode',${row}.history_mode,'historyLimit',${row}.history_limit,
  'historyFrom',${row}.history_from,'boundAtMessageId',${row}.bound_at_message_id,
  'createdAt',${row}.created_at,
  'sourceKind',(SELECT kind FROM input_sources WHERE id=${row}.source_id),
  'sourceConnectionId',(SELECT connection_id FROM input_sources WHERE id=${row}.source_id),
  'sourceExternalKey',(SELECT external_key FROM input_sources WHERE id=${row}.source_id))`;

const messageJson = (row: string) => `json_object(
  'id',${row}.id,'sourceId',${row}.source_id,'messageId',${row}.message_id,
  'connectionId',${row}.connection_id,'externalMessageId',${row}.external_message_id,
  'remoteUpdateId',${row}.remote_update_id,'messageDate',${row}.message_date,
  'body',${row}.body,'eventKind',${row}.event_kind,'contentHash',${row}.content_hash,
  'remoteEditedAt',${row}.remote_edited_at,'remoteDeletedAt',${row}.remote_deleted_at,
  'bodyDeletedAt',${row}.body_deleted_at,'createdAt',${row}.created_at,'updatedAt',${row}.updated_at,
  'sourceKind',(SELECT kind FROM input_sources WHERE id=${row}.source_id),
  'sourceConnectionId',(SELECT connection_id FROM input_sources WHERE id=${row}.source_id),
  'sourceExternalKey',(SELECT external_key FROM input_sources WHERE id=${row}.source_id))`;

const queueJson = (row: string) => `json_object(
  'id',${row}.id,'telegramMessageId',${row}.telegram_message_id,'tool',${row}.tool,
  'status',${row}.status,'messageDate',${row}.message_date,
  'candidateCount',${row}.candidate_count,'candidatePreview',${row}.candidate_preview,
  'runId',${row}.run_id,'errorMessage',${row}.error_message,
  'selectedAt',${row}.selected_at,'processingAt',${row}.processing_at,
  'processedAt',${row}.processed_at,'createdAt',${row}.created_at,'updatedAt',${row}.updated_at,
  'messageId',(SELECT message_id FROM telegram_messages WHERE id=${row}.telegram_message_id),
  'sourceKind',(SELECT s.kind FROM input_sources s JOIN telegram_messages m ON m.source_id=s.id WHERE m.id=${row}.telegram_message_id),
  'sourceConnectionId',(SELECT s.connection_id FROM input_sources s JOIN telegram_messages m ON m.source_id=s.id WHERE m.id=${row}.telegram_message_id),
  'sourceExternalKey',(SELECT s.external_key FROM input_sources s JOIN telegram_messages m ON m.source_id=s.id WHERE m.id=${row}.telegram_message_id))`;

const readStateJson = (row: string) => `json_object(
  'sourceId',${row}.source_id,'policy',${row}.policy,
  'safeReadMessageId',${row}.safe_read_message_id,
  'lastMarkedReadMessageId',${row}.last_marked_read_message_id,
  'readBaselineMessageId',${row}.read_baseline_message_id,'updatedAt',${row}.updated_at,
  'sourceKind',(SELECT kind FROM input_sources WHERE id=${row}.source_id),
  'sourceConnectionId',(SELECT connection_id FROM input_sources WHERE id=${row}.source_id),
  'sourceExternalKey',(SELECT external_key FROM input_sources WHERE id=${row}.source_id))`;

const taskJson = (row: string) => `json_object(
  'id',${row}.id,'tool',${row}.tool,'stage',${row}.stage,'phase',${row}.phase,
  'title',${row}.title,'runId',${row}.run_id,'recordId',${row}.record_id,
  'sourceId',${row}.source_id,'metadataJson',${row}.metadata_json,
  'createdAt',${row}.created_at,'updatedAt',${row}.updated_at,
  'sourceKind',(SELECT kind FROM input_sources WHERE id=${row}.source_id),
  'sourceConnectionId',(SELECT connection_id FROM input_sources WHERE id=${row}.source_id),
  'sourceExternalKey',(SELECT external_key FROM input_sources WHERE id=${row}.source_id))`;

const settingJson = (row: string) => `json_object(
  'key',${row}.key,'valueJson',${row}.value_json,'updatedAt',${row}.updated_at)`;

export const CLOUD_SYNC_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_sync_state (
    id TEXT PRIMARY KEY,node_id TEXT NOT NULL,encrypted_device_token TEXT NOT NULL DEFAULT '',
    last_pulled_sequence INTEGER NOT NULL DEFAULT 0,preview_json TEXT NOT NULL DEFAULT '{}',
    preview_expires_at TEXT NOT NULL DEFAULT '',last_success_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_sync_runtime (id INTEGER PRIMARY KEY,suppress_outbox INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO cloud_sync_runtime(id,suppress_outbox) VALUES(1,0)`,
  `CREATE TABLE IF NOT EXISTS cloud_sync_dirty (
    id INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT NOT NULL,row_key TEXT NOT NULL,
    action TEXT NOT NULL,row_json TEXT NOT NULL,changed_at TEXT NOT NULL,last_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_sync_dirty_id_idx ON cloud_sync_dirty(id)`,
  `CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
    operation_id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_key TEXT NOT NULL,action TEXT NOT NULL,
    restore INTEGER NOT NULL DEFAULT 0,base_version INTEGER NOT NULL DEFAULT 0,payload_json TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(entity_type,entity_key)
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_sync_outbox_status_created_idx ON cloud_sync_outbox(status,created_at)`,
  `CREATE TABLE IF NOT EXISTS cloud_sync_entity_versions (
    entity_type TEXT NOT NULL,entity_key TEXT NOT NULL,record_version INTEGER NOT NULL DEFAULT 0,
    tombstone INTEGER NOT NULL DEFAULT 0,payload_hash TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,
    UNIQUE(entity_type,entity_key)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_sync_conflicts (
    id TEXT PRIMARY KEY,operation_id TEXT NOT NULL DEFAULT '',entity_type TEXT NOT NULL,entity_key TEXT NOT NULL,
    current_version INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,local_json TEXT NOT NULL DEFAULT '',
    remote_json TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL,
    resolved_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_sync_conflicts_status_created_idx ON cloud_sync_conflicts(status,created_at)`,
  ...triggerSet("permanent_records", "NEW.id", "OLD.id", permanentRecordJson("NEW"), permanentRecordJson("OLD")),
  ...triggerSet("content_runs", "NEW.id", "OLD.id", contentRunJson("NEW"), contentRunJson("OLD")),
  ...triggerSet("content_results", "NEW.id", "OLD.id", contentResultJson("NEW"), contentResultJson("OLD")),
  ...triggerSet("input_sources", "NEW.id", "OLD.id", sourceJson("NEW"), sourceJson("OLD")),
  `CREATE TRIGGER IF NOT EXISTS cloud_sync_inputsources_checkpoint_insert AFTER INSERT ON input_sources
   WHEN ${runtimeAllowsOutbox} AND NEW.kind LIKE 'telegram_%'
   BEGIN
     INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
     VALUES('input_source_checkpoint',NEW.id,'upsert',${sourceJson("NEW")},COALESCE(NULLIF(NEW.updated_at,''),NEW.created_at));
   END`,
  `CREATE TRIGGER IF NOT EXISTS cloud_sync_inputsources_checkpoint_update AFTER UPDATE ON input_sources
   WHEN ${runtimeAllowsOutbox} AND NEW.kind LIKE 'telegram_%'
   BEGIN
     INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
     VALUES('input_source_checkpoint',NEW.id,'upsert',${sourceJson("NEW")},COALESCE(NULLIF(NEW.updated_at,''),NEW.created_at));
   END`,
  ...triggerSet("tool_source_bindings", "NEW.id", "OLD.id", bindingJson("NEW"), bindingJson("OLD"), "1=1", "COALESCE(NULLIF(NEW.created_at,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
  ...triggerSet("telegram_messages", "NEW.id", "OLD.id", messageJson("NEW"), messageJson("OLD")),
  ...triggerSet("telegram_tool_queue", "NEW.id", "OLD.id", queueJson("NEW"), queueJson("OLD")),
  ...triggerSet("telegram_read_states", "NEW.source_id", "OLD.source_id", readStateJson("NEW"), readStateJson("OLD"), "1=1", "COALESCE(NULLIF(NEW.updated_at,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
  ...triggerSet("task_inbox", "NEW.id", "OLD.id", taskJson("NEW"), taskJson("OLD")),
  ...triggerSet(
    "app_settings",
    "NEW.key",
    "OLD.key",
    settingJson("NEW"),
    settingJson("OLD"),
    "ROW.key IN ('referenceTags','referenceBlacklist','exportBlacklist')",
    "COALESCE(NULLIF(NEW.updated_at,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ),
];

export const CLOUD_SYNC_SEED_STATEMENTS = [
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'permanent_records',r.id,'upsert',${permanentRecordJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM permanent_records r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'content_runs',r.id,'upsert',${contentRunJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM content_runs r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'content_results',r.id,'upsert',${contentResultJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM content_results r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'input_sources',r.id,'upsert',${sourceJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM input_sources r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'input_source_checkpoint',r.id,'upsert',${sourceJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM input_sources r WHERE r.kind LIKE 'telegram_%'`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'tool_source_bindings',r.id,'upsert',${bindingJson("r")},r.created_at FROM tool_source_bindings r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'telegram_messages',r.id,'upsert',${messageJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM telegram_messages r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'telegram_tool_queue',r.id,'upsert',${queueJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM telegram_tool_queue r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'telegram_read_states',r.source_id,'upsert',${readStateJson("r")},r.updated_at FROM telegram_read_states r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'task_inbox',r.id,'upsert',${taskJson("r")},COALESCE(NULLIF(r.updated_at,''),r.created_at) FROM task_inbox r`,
  `INSERT INTO cloud_sync_dirty(table_name,row_key,action,row_json,changed_at)
   SELECT 'app_settings',r.key,'upsert',${settingJson("r")},r.updated_at FROM app_settings r
   WHERE r.key IN ('referenceTags','referenceBlacklist','exportBlacklist')`,
];

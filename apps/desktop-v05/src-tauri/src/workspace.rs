use std::fs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, TransactionBehavior};
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

pub fn permanent_count(path: &Path) -> Result<i64, String> {
    let connection = open(path)?;
    connection.query_row("SELECT COUNT(*) FROM permanent_records", [], |row| row.get(0)).map_err(|error| error.to_string())
}

pub fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS content_runs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               tool TEXT NOT NULL,
               name TEXT NOT NULL,
               input_kind TEXT NOT NULL,
               original_input TEXT NOT NULL DEFAULT '',
               start_at TEXT NOT NULL DEFAULT '',
               end_at TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'completed',
               options_json TEXT NOT NULL DEFAULT '{}',
               total_count INTEGER NOT NULL DEFAULT 0,
               result_count INTEGER NOT NULL DEFAULT 0,
               error_count INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS content_results (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               run_id INTEGER NOT NULL REFERENCES content_runs(id) ON DELETE CASCADE,
               tool TEXT NOT NULL,
               result_key TEXT NOT NULL,
               primary_value TEXT NOT NULL,
               secondary_value TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'success',
               tags_json TEXT NOT NULL DEFAULT '[]',
               error TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL DEFAULT '',
               metadata_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(run_id, result_key)
             );
             CREATE INDEX IF NOT EXISTS idx_content_results_run ON content_results(run_id, id);
             CREATE INDEX IF NOT EXISTS idx_content_results_tool_key ON content_results(tool, result_key);

             CREATE VIRTUAL TABLE IF NOT EXISTS content_results_fts USING fts5(
               result_key, primary_value, secondary_value, tags_json, error, source,
               content='content_results', content_rowid='id'
             );
             CREATE TRIGGER IF NOT EXISTS content_results_ai AFTER INSERT ON content_results BEGIN
               INSERT INTO content_results_fts(rowid, result_key, primary_value, secondary_value, tags_json, error, source)
               VALUES (new.id, new.result_key, new.primary_value, new.secondary_value, new.tags_json, new.error, new.source);
             END;
             CREATE TRIGGER IF NOT EXISTS content_results_ad AFTER DELETE ON content_results BEGIN
               INSERT INTO content_results_fts(content_results_fts, rowid, result_key, primary_value, secondary_value, tags_json, error, source)
               VALUES ('delete', old.id, old.result_key, old.primary_value, old.secondary_value, old.tags_json, old.error, old.source);
             END;
             CREATE TRIGGER IF NOT EXISTS content_results_au AFTER UPDATE ON content_results BEGIN
               INSERT INTO content_results_fts(content_results_fts, rowid, result_key, primary_value, secondary_value, tags_json, error, source)
               VALUES ('delete', old.id, old.result_key, old.primary_value, old.secondary_value, old.tags_json, old.error, old.source);
               INSERT INTO content_results_fts(rowid, result_key, primary_value, secondary_value, tags_json, error, source)
               VALUES (new.id, new.result_key, new.primary_value, new.secondary_value, new.tags_json, new.error, new.source);
             END;

             CREATE TABLE IF NOT EXISTS permanent_records (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               tool TEXT NOT NULL,
               record_key TEXT NOT NULL,
               primary_value TEXT NOT NULL,
               secondary_value TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'new',
               tags_json TEXT NOT NULL DEFAULT '[]',
               actress_tags_json TEXT NOT NULL DEFAULT '[]',
               genre_tags_json TEXT NOT NULL DEFAULT '[]',
               source_url TEXT NOT NULL DEFAULT '',
               missav_url TEXT NOT NULL DEFAULT '',
               av123_url TEXT NOT NULL DEFAULT '',
               raindrop_remote_id INTEGER,
               raindrop_collection_id INTEGER,
               metadata_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(tool, record_key)
             );
             CREATE INDEX IF NOT EXISTS idx_permanent_records_status ON permanent_records(tool, status, id);

             CREATE VIRTUAL TABLE IF NOT EXISTS permanent_records_fts USING fts5(
               record_key, primary_value, secondary_value, tags_json, actress_tags_json, genre_tags_json,
               content='permanent_records', content_rowid='id'
             );
             CREATE TRIGGER IF NOT EXISTS permanent_records_ai AFTER INSERT ON permanent_records BEGIN
               INSERT INTO permanent_records_fts(rowid, record_key, primary_value, secondary_value, tags_json, actress_tags_json, genre_tags_json)
               VALUES (new.id, new.record_key, new.primary_value, new.secondary_value, new.tags_json, new.actress_tags_json, new.genre_tags_json);
             END;
             CREATE TRIGGER IF NOT EXISTS permanent_records_ad AFTER DELETE ON permanent_records BEGIN
               INSERT INTO permanent_records_fts(permanent_records_fts, rowid, record_key, primary_value, secondary_value, tags_json, actress_tags_json, genre_tags_json)
               VALUES ('delete', old.id, old.record_key, old.primary_value, old.secondary_value, old.tags_json, old.actress_tags_json, old.genre_tags_json);
             END;
             CREATE TRIGGER IF NOT EXISTS permanent_records_au AFTER UPDATE ON permanent_records BEGIN
               INSERT INTO permanent_records_fts(permanent_records_fts, rowid, record_key, primary_value, secondary_value, tags_json, actress_tags_json, genre_tags_json)
               VALUES ('delete', old.id, old.record_key, old.primary_value, old.secondary_value, old.tags_json, old.actress_tags_json, old.genre_tags_json);
               INSERT INTO permanent_records_fts(rowid, record_key, primary_value, secondary_value, tags_json, actress_tags_json, genre_tags_json)
               VALUES (new.id, new.record_key, new.primary_value, new.secondary_value, new.tags_json, new.actress_tags_json, new.genre_tags_json);
             END;

             CREATE TABLE IF NOT EXISTS input_sources (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL,
               external_id TEXT NOT NULL DEFAULT '',
               name TEXT NOT NULL,
               source_type TEXT NOT NULL DEFAULT '',
               enabled INTEGER NOT NULL DEFAULT 1,
               checkpoint TEXT NOT NULL DEFAULT '',
               continuation TEXT NOT NULL DEFAULT '',
               metadata_json TEXT NOT NULL DEFAULT '{}',
               last_sync_at TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(kind, external_id)
             );
             CREATE TABLE IF NOT EXISTS tool_source_bindings (
               tool TEXT NOT NULL,
               source_id INTEGER NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
               created_at TEXT NOT NULL,
               PRIMARY KEY(tool, source_id)
             );

             CREATE TABLE IF NOT EXISTS app_settings (
               key TEXT PRIMARY KEY,
               value_json TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS cloud_sync_state (
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               node_id TEXT NOT NULL DEFAULT '',
               gateway_url TEXT NOT NULL DEFAULT '',
               last_pulled_sequence INTEGER NOT NULL DEFAULT 0,
               last_push_at TEXT NOT NULL DEFAULT '',
               last_pull_at TEXT NOT NULL DEFAULT '',
               last_success_at TEXT NOT NULL DEFAULT '',
               last_error TEXT NOT NULL DEFAULT '',
               preview_id TEXT NOT NULL DEFAULT '',
               preview_local_hash TEXT NOT NULL DEFAULT '',
               preview_remote_sequence INTEGER NOT NULL DEFAULT 0,
               previewed_at TEXT NOT NULL DEFAULT '',
               last_remote_sequence INTEGER NOT NULL DEFAULT 0,
               bootstrap_completed INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL
             );
             INSERT OR IGNORE INTO cloud_sync_state(singleton,updated_at) VALUES(1,'');

             CREATE TABLE IF NOT EXISTS cloud_sync_entities (
               entity_type TEXT NOT NULL,
               entity_key TEXT NOT NULL,
               record_version INTEGER NOT NULL DEFAULT 0,
               payload_hash TEXT NOT NULL DEFAULT '',
               tombstone INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(entity_type,entity_key)
             );

             CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
               operation_id TEXT PRIMARY KEY,
               entity_type TEXT NOT NULL,
               entity_key TEXT NOT NULL,
               action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
               restore INTEGER NOT NULL DEFAULT 0,
               base_version INTEGER NOT NULL DEFAULT 0,
               payload_json TEXT NOT NULL DEFAULT '',
               occurred_at TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               attempt_count INTEGER NOT NULL DEFAULT 0,
               last_error TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_status ON cloud_sync_outbox(status,created_at);

             CREATE TABLE IF NOT EXISTS cloud_sync_conflicts (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               operation_id TEXT NOT NULL DEFAULT '',
               entity_type TEXT NOT NULL,
               entity_key TEXT NOT NULL,
               reason TEXT NOT NULL,
               local_json TEXT NOT NULL DEFAULT '',
               remote_json TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'open',
               created_at TEXT NOT NULL,
               resolved_at TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_cloud_sync_conflicts_status ON cloud_sync_conflicts(status,id DESC);
             CREATE TABLE IF NOT EXISTS app_logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               level TEXT NOT NULL,
               category TEXT NOT NULL,
               message TEXT NOT NULL,
               details_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(id DESC);

             CREATE TABLE IF NOT EXISTS remote_mirrors (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               service TEXT NOT NULL,
               local_key TEXT NOT NULL,
               remote_id TEXT NOT NULL,
               collection_id TEXT NOT NULL DEFAULT '',
               payload_hash TEXT NOT NULL DEFAULT '',
               remote_updated_at TEXT NOT NULL DEFAULT '',
               last_sync_at TEXT NOT NULL,
               metadata_json TEXT NOT NULL DEFAULT '{}',
               UNIQUE(service, remote_id)
             );

             CREATE TABLE IF NOT EXISTS telegram_message_fingerprints (
               source_id INTEGER NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
               message_id INTEGER NOT NULL,
               message_date TEXT NOT NULL DEFAULT '',
               content_hash TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               PRIMARY KEY(source_id, message_id)
             );
             CREATE INDEX IF NOT EXISTS idx_telegram_fingerprints_date ON telegram_message_fingerprints(source_id, message_date);

             CREATE TABLE IF NOT EXISTS telegram_messages (
               source_id INTEGER NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
               message_id INTEGER NOT NULL,
               message_date TEXT NOT NULL DEFAULT '',
               message_text TEXT NOT NULL DEFAULT '',
               content_hash TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(source_id, message_id)
             );
             CREATE INDEX IF NOT EXISTS idx_telegram_messages_date ON telegram_messages(source_id, message_date DESC, message_id DESC);

             CREATE TABLE IF NOT EXISTS telegram_tool_queue (
               source_id INTEGER NOT NULL,
               message_id INTEGER NOT NULL,
               tool TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               candidate_count INTEGER NOT NULL DEFAULT -1,
               candidate_preview TEXT NOT NULL DEFAULT '',
               run_id INTEGER REFERENCES content_runs(id) ON DELETE SET NULL,
               error TEXT NOT NULL DEFAULT '',
               processed_at TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(source_id, message_id, tool),
               FOREIGN KEY(source_id, message_id) REFERENCES telegram_messages(source_id, message_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_telegram_tool_queue_work ON telegram_tool_queue(tool, status, source_id, message_id DESC);

             CREATE TABLE IF NOT EXISTS telegram_load_sessions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               tool TEXT NOT NULL,
               source_id INTEGER NOT NULL REFERENCES input_sources(id) ON DELETE CASCADE,
               mode TEXT NOT NULL,
               requested_count INTEGER NOT NULL DEFAULT 0,
               scanned_count INTEGER NOT NULL DEFAULT 0,
               loaded_count INTEGER NOT NULL DEFAULT 0,
               next_before_id INTEGER NOT NULL DEFAULT 0,
               next_after_id INTEGER NOT NULL DEFAULT 0,
               status TEXT NOT NULL,
               error TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_telegram_load_sessions_tool ON telegram_load_sessions(tool, source_id, id DESC);

             CREATE TABLE IF NOT EXISTS sync_transactions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               source_id INTEGER REFERENCES input_sources(id) ON DELETE SET NULL,
               source_kind TEXT NOT NULL,
               status TEXT NOT NULL,
               message_count INTEGER NOT NULL DEFAULT 0,
               run_ids_json TEXT NOT NULL DEFAULT '[]',
               checkpoint TEXT NOT NULL DEFAULT '',
               error TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS task_inbox (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               run_id INTEGER NOT NULL UNIQUE REFERENCES content_runs(id) ON DELETE CASCADE,
               source_id INTEGER REFERENCES input_sources(id) ON DELETE SET NULL,
               tool TEXT NOT NULL,
               stage TEXT NOT NULL,
               title TEXT NOT NULL,
               summary TEXT NOT NULL DEFAULT '',
               error TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_task_inbox_stage ON task_inbox(stage, id DESC);

             CREATE TABLE IF NOT EXISTS script_generations (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               run_id INTEGER REFERENCES content_runs(id) ON DELETE SET NULL,
               template_version TEXT NOT NULL,
               code_count INTEGER NOT NULL,
               created_at TEXT NOT NULL
             );

             PRAGMA user_version=508;",
        )
        .map_err(|error| format!("初始化 v0.5 正式数据结构失败：{error}"))?;
    for column in [
        "preview_id TEXT NOT NULL DEFAULT ''",
        "preview_local_hash TEXT NOT NULL DEFAULT ''",
        "preview_remote_sequence INTEGER NOT NULL DEFAULT 0",
        "previewed_at TEXT NOT NULL DEFAULT ''",
        "last_remote_sequence INTEGER NOT NULL DEFAULT 0",
        "bootstrap_completed INTEGER NOT NULL DEFAULT 0",
    ] {
        let _ = connection.execute(&format!("ALTER TABLE cloud_sync_state ADD COLUMN {column}"), []);
    }
    let _ = connection.execute("ALTER TABLE cloud_sync_outbox ADD COLUMN restore INTEGER NOT NULL DEFAULT 0", []);
    let _ = connection.execute(
        "UPDATE cloud_sync_state
         SET bootstrap_completed=1
         WHERE bootstrap_completed=0
           AND (last_success_at<>'' OR last_pulled_sequence>0 OR EXISTS(SELECT 1 FROM cloud_sync_entities))",
        [],
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultInput {
    pub result_key: String,
    pub primary_value: String,
    #[serde(default)]
    pub secondary_value: String,
    #[serde(default = "default_success")]
    pub status: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

fn default_success() -> String {
    "success".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunInput {
    pub tool: String,
    pub name: String,
    pub input_kind: String,
    pub original_input: String,
    #[serde(default)]
    pub start_at: String,
    #[serde(default)]
    pub end_at: String,
    #[serde(default)]
    pub options: serde_json::Value,
    #[serde(default)]
    pub results: Vec<ResultInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: i64,
    pub tool: String,
    pub name: String,
    pub input_kind: String,
    pub status: String,
    pub total_count: i64,
    pub result_count: i64,
    pub error_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentResult {
    pub id: i64,
    pub run_id: i64,
    pub tool: String,
    pub result_key: String,
    pub primary_value: String,
    pub secondary_value: String,
    pub status: String,
    pub tags: Vec<String>,
    pub error: String,
    pub source: String,
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    #[serde(flatten)]
    pub summary: RunSummary,
    pub original_input: String,
    pub start_at: String,
    pub end_at: String,
    pub options: serde_json::Value,
    pub results: Vec<ContentResult>,
}

fn run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunSummary> {
    Ok(RunSummary {
        id: row.get(0)?,
        tool: row.get(1)?,
        name: row.get(2)?,
        input_kind: row.get(3)?,
        status: row.get(4)?,
        total_count: row.get(5)?,
        result_count: row.get(6)?,
        error_count: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn parse_json<T: serde::de::DeserializeOwned + Default>(value: String) -> T {
    serde_json::from_str(&value).unwrap_or_default()
}

fn result_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContentResult> {
    let tags: String = row.get(7)?;
    let metadata: String = row.get(10)?;
    Ok(ContentResult {
        id: row.get(0)?,
        run_id: row.get(1)?,
        tool: row.get(2)?,
        result_key: row.get(3)?,
        primary_value: row.get(4)?,
        secondary_value: row.get(5)?,
        status: row.get(6)?,
        tags: parse_json(tags),
        error: row.get(8)?,
        source: row.get(9)?,
        metadata: parse_json(metadata),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn validate_run(input: &CreateRunInput) -> Result<(), String> {
    if !["twitter", "badnews", "haijiao", "missav", "av123"].contains(&input.tool.as_str()) {
        return Err("未知工具".to_string());
    }
    if input.name.trim().is_empty() {
        return Err("任务名称不能为空".to_string());
    }
    Ok(())
}

fn insert_run(connection: &Connection, input: &CreateRunInput, timestamp: &str, source_id: Option<i64>) -> Result<i64, String> {
    validate_run(input)?;
    let result_count = input.results.len() as i64;
    let error_count = input
        .results
        .iter()
        .filter(|item| item.status == "error" || !item.error.is_empty())
        .count() as i64;
    connection
        .execute(
            "INSERT INTO content_runs
             (tool,name,input_kind,original_input,start_at,end_at,status,options_json,total_count,result_count,error_count,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,'completed',?7,?8,?9,?10,?11,?11)",
            params![
                &input.tool,
                input.name.trim(),
                &input.input_kind,
                &input.original_input,
                &input.start_at,
                &input.end_at,
                serde_json::to_string(&input.options).unwrap_or_else(|_| "{}".to_string()),
                input.results.len() as i64,
                result_count,
                error_count,
                timestamp
            ],
        )
        .map_err(|error| format!("保存任务失败：{error}"))?;
    let run_id = connection.last_insert_rowid();
    {
        let mut statement = connection
            .prepare_cached(
                "INSERT OR IGNORE INTO content_results
                 (run_id,tool,result_key,primary_value,secondary_value,status,tags_json,error,source,metadata_json,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
            )
            .map_err(|error| error.to_string())?;
        let mut permanent = connection
            .prepare_cached(
                "INSERT INTO permanent_records
                 (tool,record_key,primary_value,secondary_value,status,tags_json,source_url,metadata_json,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
                 ON CONFLICT(tool,record_key) DO UPDATE SET
                   primary_value=excluded.primary_value,
                   secondary_value=CASE WHEN excluded.secondary_value<>'' THEN excluded.secondary_value ELSE permanent_records.secondary_value END,
                   status=excluded.status,
                   tags_json=excluded.tags_json,
                   source_url=CASE WHEN excluded.source_url<>'' THEN excluded.source_url ELSE permanent_records.source_url END,
                   metadata_json=excluded.metadata_json,
                   updated_at=excluded.updated_at",
            )
            .map_err(|error| error.to_string())?;
        for result in &input.results {
            let tags_json = serde_json::to_string(&result.tags).unwrap_or_else(|_| "[]".to_string());
            let metadata_json = serde_json::to_string(&result.metadata).unwrap_or_else(|_| "{}".to_string());
            statement
                .execute(params![
                    run_id,
                    &input.tool,
                    &result.result_key,
                    &result.primary_value,
                    &result.secondary_value,
                    &result.status,
                    &tags_json,
                    &result.error,
                    &result.source,
                    &metadata_json,
                    timestamp
                ])
                .map_err(|error| error.to_string())?;
            permanent
                .execute(params![
                    &input.tool,
                    &result.result_key,
                    &result.primary_value,
                    &result.secondary_value,
                    &result.status,
                    &tags_json,
                    &result.source,
                    &metadata_json,
                    timestamp
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    let stage = if error_count > 0 { "exception" } else if input.tool == "missav" || input.tool == "av123" { "website_action" } else { "filtered" };
    connection.execute(
        "INSERT INTO task_inbox(run_id,source_id,tool,stage,title,summary,error,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'',?7,?7)",
        params![run_id, source_id, &input.tool, stage, input.name.trim(), format!("{} 条结果", result_count), timestamp],
    ).map_err(|error| format!("写入处理中心失败：{error}"))?;
    Ok(run_id)
}

pub fn create_run(path: &Path, input: CreateRunInput) -> Result<i64, String> {
    validate_run(&input)?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let run_id = insert_run(&transaction, &input, &now(), None)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(run_id)
}

pub fn list_runs(path: &Path, tool: Option<&str>, search: &str, limit: u32) -> Result<Vec<RunSummary>, String> {
    let connection = open(path)?;
    let tool = tool.unwrap_or("").trim();
    let search = format!("%{}%", search.trim());
    let mut statement = connection
        .prepare(
            "SELECT id,tool,name,input_kind,status,total_count,result_count,error_count,created_at,updated_at
             FROM content_runs
             WHERE (?1='' OR tool=?1) AND (?2='%%' OR name LIKE ?2)
             ORDER BY id DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![tool, search, limit.clamp(1, 500)], run_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

pub fn get_run(path: &Path, run_id: i64) -> Result<RunDetail, String> {
    let connection = open(path)?;
    let row = connection
        .query_row(
            "SELECT id,tool,name,input_kind,status,total_count,result_count,error_count,created_at,updated_at,
                    original_input,start_at,end_at,options_json
             FROM content_runs WHERE id=?1",
            params![run_id],
            |row| {
                let options: String = row.get(13)?;
                Ok((
                    RunSummary {
                        id: row.get(0)?,
                        tool: row.get(1)?,
                        name: row.get(2)?,
                        input_kind: row.get(3)?,
                        status: row.get(4)?,
                        total_count: row.get(5)?,
                        result_count: row.get(6)?,
                        error_count: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    },
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    parse_json(options),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "历史任务不存在".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id,run_id,tool,result_key,primary_value,secondary_value,status,tags_json,error,source,metadata_json,created_at,updated_at
             FROM content_results WHERE run_id=?1 ORDER BY id",
        )
        .map_err(|error| error.to_string())?;
    let results = statement
        .query_map(params![run_id], result_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(RunDetail {
        summary: row.0,
        original_input: row.1,
        start_at: row.2,
        end_at: row.3,
        options: row.4,
        results,
    })
}

pub fn rename_run(path: &Path, run_id: i64, name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("名称不能为空".to_string());
    }
    let connection = open(path)?;
    connection
        .execute(
            "UPDATE content_runs SET name=?1,updated_at=?2 WHERE id=?3",
            params![name.trim(), now(), run_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn delete_run(path: &Path, run_id: i64) -> Result<(), String> {
    create_backup(path, Some("before-delete-run"))?;
    let connection = open(path)?;
    connection
        .execute("DELETE FROM content_runs WHERE id=?1", params![run_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultUpdate {
    pub id: i64,
    pub field: String,
    pub value: serde_json::Value,
}

pub fn update_result(path: &Path, update: ResultUpdate) -> Result<(), String> {
    let allowed = ["result_key", "primary_value", "secondary_value", "status", "tags_json", "error", "source", "metadata_json"];
    if !allowed.contains(&update.field.as_str()) {
        return Err("不允许编辑该字段".to_string());
    }
    let value = if update.field.ends_with("_json") {
        serde_json::to_string(&update.value).map_err(|_| "JSON 值无效".to_string())?
    } else {
        update.value.as_str().unwrap_or_default().trim().to_string()
    };
    let connection = open(path)?;
    let sql = format!("UPDATE content_results SET {}=?1,updated_at=?2 WHERE id=?3", update.field);
    connection
        .execute(&sql, params![value, now(), update.id])
        .map_err(|error| format!("保存失败：{error}"))?;
    let permanent_field = match update.field.as_str() {
        "result_key" => Some("record_key"), "primary_value" => Some("primary_value"),
        "secondary_value" => Some("secondary_value"), "status" => Some("status"),
        "tags_json" => Some("tags_json"), "metadata_json" => Some("metadata_json"), _ => None,
    };
    if let Some(field) = permanent_field {
        let mirror_sql = format!("UPDATE permanent_records SET {field}=?1,updated_at=?2 WHERE (tool,record_key)=(SELECT tool,result_key FROM content_results WHERE id=?3)");
        connection.execute(&mirror_sql, params![value, now(), update.id]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn delete_results(path: &Path, ids: &[i64]) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    create_backup(path, Some("before-delete-results"))?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut changed = 0;
    for id in ids {
        changed += transaction
            .execute("DELETE FROM content_results WHERE id=?1", params![id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentRecord {
    pub id: i64,
    pub tool: String,
    pub record_key: String,
    pub primary_value: String,
    pub secondary_value: String,
    pub status: String,
    pub tags: Vec<String>,
    pub actress_tags: Vec<String>,
    pub genre_tags: Vec<String>,
    pub source_url: String,
    pub missav_url: String,
    pub av123_url: String,
    pub raindrop_remote_id: Option<i64>,
    pub raindrop_collection_id: Option<i64>,
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentPage {
    pub data: Vec<PermanentRecord>,
    pub page: u32,
    pub page_size: u32,
    pub last_page: u32,
    pub total: i64,
}

fn permanent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PermanentRecord> {
    let tags: String = row.get(6)?;
    let actresses: String = row.get(7)?;
    let genres: String = row.get(8)?;
    let metadata: String = row.get(14)?;
    Ok(PermanentRecord {
        id: row.get(0)?, tool: row.get(1)?, record_key: row.get(2)?, primary_value: row.get(3)?,
        secondary_value: row.get(4)?, status: row.get(5)?, tags: parse_json(tags),
        actress_tags: parse_json(actresses), genre_tags: parse_json(genres), source_url: row.get(9)?,
        missav_url: row.get(10)?, av123_url: row.get(11)?, raindrop_remote_id: row.get(12)?,
        raindrop_collection_id: row.get(13)?, metadata: parse_json(metadata), created_at: row.get(15)?, updated_at: row.get(16)?,
    })
}

fn fts_query(search: &str) -> String {
    search.split_whitespace().filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\""))).collect::<Vec<_>>().join(" AND ")
}

pub fn query_permanent(path: &Path, tool: &str, page: u32, page_size: u32, search: &str) -> Result<PermanentPage, String> {
    let connection = open(path)?;
    let page = page.max(1);
    let page_size = page_size.clamp(20, 500);
    let offset = i64::from((page - 1) * page_size);
    let base_select = "SELECT p.id,p.tool,p.record_key,p.primary_value,p.secondary_value,p.status,p.tags_json,p.actress_tags_json,p.genre_tags_json,p.source_url,p.missav_url,p.av123_url,p.raindrop_remote_id,p.raindrop_collection_id,p.metadata_json,p.created_at,p.updated_at FROM permanent_records p";
    let trimmed = search.trim();
    let (total, data) = if trimmed.is_empty() {
        let total = connection.query_row("SELECT COUNT(*) FROM permanent_records WHERE (?1='' OR tool=?1)", params![tool], |row| row.get(0)).map_err(|error| error.to_string())?;
        let sql = format!("{base_select} WHERE (?1='' OR p.tool=?1) ORDER BY p.id DESC LIMIT ?2 OFFSET ?3");
        let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
        let data = statement.query_map(params![tool, page_size, offset], permanent_from_row).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        (total, data)
    } else {
        let query = fts_query(trimmed);
        let total = connection.query_row("SELECT COUNT(*) FROM permanent_records p JOIN permanent_records_fts f ON f.rowid=p.id WHERE (?1='' OR p.tool=?1) AND permanent_records_fts MATCH ?2", params![tool, query], |row| row.get(0)).map_err(|error| error.to_string())?;
        let sql = format!("{base_select} JOIN permanent_records_fts f ON f.rowid=p.id WHERE (?1='' OR p.tool=?1) AND permanent_records_fts MATCH ?2 ORDER BY p.id DESC LIMIT ?3 OFFSET ?4");
        let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
        let data = statement.query_map(params![tool, query, page_size, offset], permanent_from_row).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        (total, data)
    };
    let last_page = if total == 0 { 1 } else { ((total as u32) + page_size - 1) / page_size };
    Ok(PermanentPage { data, page, page_size, last_page, total })
}

pub fn query_permanent_ids(path: &Path, tool: &str, search: &str) -> Result<Vec<i64>, String> {
    let connection = open(path)?;
    let trimmed = search.trim();
    let mut output = Vec::new();
    if trimmed.is_empty() {
        let mut statement = connection
            .prepare("SELECT id FROM permanent_records WHERE (?1='' OR tool=?1) ORDER BY id DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![tool], |row| row.get(0)).map_err(|error| error.to_string())?;
        for row in rows { output.push(row.map_err(|error| error.to_string())?); }
    } else {
        let query = fts_query(trimmed);
        let mut statement = connection
            .prepare("SELECT p.id FROM permanent_records p JOIN permanent_records_fts f ON f.rowid=p.id WHERE (?1='' OR p.tool=?1) AND permanent_records_fts MATCH ?2 ORDER BY p.id DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![tool, query], |row| row.get(0)).map_err(|error| error.to_string())?;
        for row in rows { output.push(row.map_err(|error| error.to_string())?); }
    }
    Ok(output)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentUpdate { pub id: i64, pub field: String, pub value: serde_json::Value }

fn permanent_update_value(field: &str, value: &serde_json::Value) -> Result<String, String> {
    if field.ends_with("_json") {
        serde_json::to_string(value).map_err(|error| error.to_string())
    } else {
        Ok(value.as_str().unwrap_or_default().trim().to_string())
    }
}

pub fn update_permanent(path: &Path, input: PermanentUpdate) -> Result<(), String> {
    let allowed = ["record_key","primary_value","secondary_value","status","tags_json","actress_tags_json","genre_tags_json","source_url","missav_url","av123_url","metadata_json"];
    if !allowed.contains(&input.field.as_str()) { return Err("不允许编辑该字段".to_string()); }
    create_backup(path, Some("before-edit-record"))?;
    let value = permanent_update_value(&input.field, &input.value)?;
    let connection = open(path)?;
    let sql = format!("UPDATE permanent_records SET {}=?1,updated_at=?2 WHERE id=?3", input.field);
    let changed = connection.execute(&sql, params![value, now(), input.id]).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("记录不存在".to_string()); }
    Ok(())
}

pub fn update_permanent_many(path: &Path, ids: &[i64], field: &str, value: &serde_json::Value) -> Result<usize, String> {
    let allowed = ["record_key","primary_value","secondary_value","status","tags_json","actress_tags_json","genre_tags_json","source_url","missav_url","av123_url","metadata_json"];
    if ids.is_empty() { return Ok(0); }
    if !allowed.contains(&field) { return Err("不允许批量编辑该字段".to_string()); }
    let value = permanent_update_value(field, value)?;
    create_backup(path, Some("before-bulk-edit-records"))?;
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let sql = format!("UPDATE permanent_records SET {field}=?1,updated_at=?2 WHERE id=?3");
    let mut changed = 0;
    for id in ids { changed += transaction.execute(&sql, params![value, now(), id]).map_err(|error| error.to_string())?; }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

pub fn delete_permanent(path: &Path, ids: &[i64]) -> Result<usize, String> {
    if ids.is_empty() { return Ok(0); }
    create_backup(path, Some("before-delete-records"))?;
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let mut changed = 0;
    for id in ids { changed += transaction.execute("DELETE FROM permanent_records WHERE id=?1", params![id]).map_err(|error| error.to_string())?; }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub id: i64,
    pub kind: String,
    pub external_id: String,
    pub name: String,
    pub source_type: String,
    pub enabled: bool,
    pub checkpoint: String,
    pub continuation: String,
    pub metadata: serde_json::Value,
    pub last_sync_at: String,
    pub bound_tools: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub id: Option<i64>,
    pub kind: String,
    pub external_id: String,
    pub name: String,
    #[serde(default)]
    pub source_type: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub checkpoint: String,
    #[serde(default)]
    pub continuation: String,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub bound_tools: Vec<String>,
}

fn default_true() -> bool {
    true
}

pub fn save_source(path: &Path, input: SourceInput) -> Result<i64, String> {
    if input.name.trim().is_empty() {
        return Err("来源名称不能为空".to_string());
    }
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    let metadata = serde_json::to_string(&input.metadata).unwrap_or_else(|_| "{}".to_string());
    let source_id = if let Some(id) = input.id {
        transaction
            .execute(
                "UPDATE input_sources SET kind=?1,external_id=?2,name=?3,source_type=?4,enabled=?5,checkpoint=?6,continuation=?7,metadata_json=?8,updated_at=?9 WHERE id=?10",
                params![input.kind,input.external_id,input.name.trim(),input.source_type,input.enabled as i64,input.checkpoint,input.continuation,metadata,timestamp,id],
            )
            .map_err(|error| error.to_string())?;
        id
    } else {
        transaction
            .execute(
                "INSERT INTO input_sources(kind,external_id,name,source_type,enabled,checkpoint,continuation,metadata_json,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
                 ON CONFLICT(kind,external_id) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,enabled=excluded.enabled,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",
                params![input.kind,input.external_id,input.name.trim(),input.source_type,input.enabled as i64,input.checkpoint,input.continuation,metadata,timestamp],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .query_row(
                "SELECT id FROM input_sources WHERE kind=?1 AND external_id=?2",
                params![input.kind, input.external_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?
    };
    transaction
        .execute("DELETE FROM tool_source_bindings WHERE source_id=?1", params![source_id])
        .map_err(|error| error.to_string())?;
    for tool in input.bound_tools {
        if ["twitter", "badnews", "haijiao", "missav", "av123"].contains(&tool.as_str()) {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO tool_source_bindings(tool,source_id,created_at) VALUES (?1,?2,?3)",
                    params![tool, source_id, timestamp],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(source_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSourceBindingUpdate {
    pub source_id: i64,
    pub bound: bool,
}

pub fn update_tool_source_bindings(
    path: &Path,
    tool: &str,
    updates: Vec<ToolSourceBindingUpdate>,
) -> Result<usize, String> {
    if !["twitter", "badnews", "haijiao", "missav", "av123"].contains(&tool) {
        return Err("未知工具，无法修改群组绑定".to_string());
    }
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    for update in &updates {
        let exists: Option<i64> = transaction
            .query_row(
                "SELECT id FROM input_sources WHERE id=?1 AND kind IN ('telegram_user','telegram_bot')",
                params![update.source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if exists.is_none() {
            return Err(format!("Telegram 来源 {} 不存在", update.source_id));
        }
        if update.bound {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO tool_source_bindings(tool,source_id,created_at) VALUES (?1,?2,?3)",
                    params![tool, update.source_id, timestamp],
                )
                .map_err(|error| error.to_string())?;
        } else {
            transaction
                .execute(
                    "DELETE FROM tool_source_bindings WHERE tool=?1 AND source_id=?2",
                    params![tool, update.source_id],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "UPDATE input_sources SET updated_at=?1 WHERE id=?2",
                params![timestamp, update.source_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updates.len())
}

pub fn list_sources(path: &Path) -> Result<Vec<SourceRecord>, String> {
    let connection = open(path)?;
    let mut statement = connection
        .prepare(
            "SELECT id,kind,external_id,name,source_type,enabled,checkpoint,continuation,metadata_json,last_sync_at
             FROM input_sources ORDER BY name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let base = statement
        .query_map([], |row| {
            let metadata: String = row.get(8)?;
            Ok(SourceRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                external_id: row.get(2)?,
                name: row.get(3)?,
                source_type: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                checkpoint: row.get(6)?,
                continuation: row.get(7)?,
                metadata: parse_json(metadata),
                last_sync_at: row.get(9)?,
                bound_tools: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut output = Vec::with_capacity(base.len());
    for mut source in base {
        let mut binding_statement = connection
            .prepare("SELECT tool FROM tool_source_bindings WHERE source_id=?1 ORDER BY tool")
            .map_err(|error| error.to_string())?;
        source.bound_tools = binding_statement
            .query_map(params![source.id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        output.push(source);
    }
    Ok(output)
}

pub fn delete_source(path: &Path, source_id: i64) -> Result<(), String> {
    let connection = open(path)?;
    connection
        .execute("DELETE FROM input_sources WHERE id=?1", params![source_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramFingerprintInput {
    pub message_id: i64,
    #[serde(default)]
    pub message_date: String,
    #[serde(default)]
    pub content_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramCommitInput {
    pub source_id: i64,
    pub checkpoint: String,
    #[serde(default)]
    pub continuation: String,
    #[serde(default)]
    pub fingerprints: Vec<TelegramFingerprintInput>,
    #[serde(default)]
    pub runs: Vec<CreateRunInput>,
    #[serde(default)]
    pub safe_read_message_id: i64,
    #[serde(default)]
    pub read_state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramCommitResult {
    pub run_ids: Vec<i64>,
    pub saved_messages: usize,
    pub checkpoint: String,
}

pub fn known_telegram_message_ids(path: &Path, source_id: i64, ids: &[i64]) -> Result<Vec<i64>, String> {
    if ids.is_empty() { return Ok(Vec::new()); }
    let connection = open(path)?;
    let mut statement = connection.prepare("SELECT 1 FROM telegram_message_fingerprints WHERE source_id=?1 AND message_id=?2").map_err(|error| error.to_string())?;
    let mut found = Vec::new();
    for id in ids {
        if statement.query_row(params![source_id, id], |_| Ok(())).optional().map_err(|error| error.to_string())?.is_some() { found.push(*id); }
    }
    Ok(found)
}

pub fn commit_telegram_sync(path: &Path, input: TelegramCommitInput) -> Result<TelegramCommitResult, String> {
    let mut connection = open(path)?;
    for run in &input.runs { validate_run(run)?; if run.results.is_empty() { return Err("原子同步不允许写入空任务".to_string()); } }
    if !["", "pending", "disabled", "history_skipped"].contains(&input.read_state.as_str()) {
        return Err("Telegram 已读状态无效".to_string());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let (source_kind, metadata_json): (String, String) = transaction
        .query_row(
            "SELECT kind,metadata_json FROM input_sources WHERE id=?1",
            params![input.source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Telegram 来源不存在或已删除".to_string())?;
    if !["telegram_user", "telegram_bot"].contains(&source_kind.as_str()) { return Err("该来源不是 Telegram 来源".to_string()); }
    let timestamp = now();
    let mut run_ids = Vec::new();
    for run in &input.runs { run_ids.push(insert_run(&transaction, run, &timestamp, Some(input.source_id))?); }
    let mut saved_messages = 0;
    {
        let mut statement = transaction.prepare_cached("INSERT OR IGNORE INTO telegram_message_fingerprints(source_id,message_id,message_date,content_hash,created_at) VALUES (?1,?2,?3,?4,?5)").map_err(|error| error.to_string())?;
        for fingerprint in &input.fingerprints {
            saved_messages += statement.execute(params![input.source_id, fingerprint.message_id, &fingerprint.message_date, &fingerprint.content_hash, &timestamp]).map_err(|error| error.to_string())?;
        }
    }
    let mut metadata: serde_json::Value = parse_json(metadata_json);
    if !metadata.is_object() { metadata = serde_json::json!({}); }
    if source_kind == "telegram_user" && !input.read_state.is_empty() {
        let object = metadata.as_object_mut().expect("Telegram 来源元数据已初始化为对象");
        let previous_safe = object.get("safeReadMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
        let mut projected_safe = previous_safe;
        if input.safe_read_message_id > 0 {
            projected_safe = previous_safe.max(input.safe_read_message_id);
            object.insert("safeReadMessageId".to_string(), serde_json::json!(projected_safe));
        }
        if input.read_state == "history_skipped" {
            let previous_baseline = object.get("readBaselineMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
            let checkpoint = input.checkpoint.parse::<i64>().unwrap_or(0);
            if checkpoint > 0 {
                object.insert("readBaselineMessageId".to_string(), serde_json::json!(previous_baseline.max(checkpoint)));
            }
        }
        let baseline = object.get("readBaselineMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
        let marked = object.get("lastMarkedReadMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
        let state = if input.read_state == "pending" && projected_safe <= baseline.max(marked) {
            if baseline > marked { "baseline" } else { "marked" }
        } else {
            input.read_state.as_str()
        };
        object.insert("readState".to_string(), serde_json::json!(state));
        object.insert("readError".to_string(), serde_json::json!(""));
    }
    let metadata_json = serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string());
    transaction.execute("UPDATE input_sources SET checkpoint=?1,continuation=?2,metadata_json=?3,last_sync_at=?4,updated_at=?4 WHERE id=?5", params![&input.checkpoint, &input.continuation, metadata_json, &timestamp, input.source_id]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO sync_transactions(source_id,source_kind,status,message_count,run_ids_json,checkpoint,error,created_at,updated_at) VALUES (?1,?2,'completed',?3,?4,?5,'',?6,?6)", params![input.source_id, source_kind, saved_messages as i64, serde_json::to_string(&run_ids).unwrap_or_else(|_| "[]".to_string()), &input.checkpoint, &timestamp]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(TelegramCommitResult { run_ids, saved_messages, checkpoint: input.checkpoint })
}

pub fn telegram_user_source_external_id(path: &Path, source_id: i64) -> Result<String, String> {
    let connection = open(path)?;
    connection
        .query_row(
            "SELECT external_id FROM input_sources WHERE id=?1 AND kind='telegram_user'",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Telegram 个人 API 来源不存在或已删除".to_string())
}

pub fn update_telegram_read_result(path: &Path, source_id: i64, message_id: i64, error: &str) -> Result<(), String> {
    if message_id <= 0 { return Err("没有可标记已读的消息".to_string()); }
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|reason| reason.to_string())?;
    let metadata_json: String = transaction
        .query_row(
            "SELECT metadata_json FROM input_sources WHERE id=?1 AND kind='telegram_user'",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|reason| reason.to_string())?
        .ok_or_else(|| "Telegram 个人 API 来源不存在或已删除".to_string())?;
    let mut metadata: serde_json::Value = parse_json(metadata_json);
    if !metadata.is_object() { metadata = serde_json::json!({}); }
    let object = metadata.as_object_mut().expect("Telegram 来源元数据已初始化为对象");
    if error.trim().is_empty() {
        let previous = object.get("lastMarkedReadMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
        let safe = object.get("safeReadMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
        let baseline = object.get("readBaselineMessageId").and_then(|value| value.as_i64()).unwrap_or(0);
        let marked = previous.max(message_id);
        object.insert("lastMarkedReadMessageId".to_string(), serde_json::json!(marked));
        object.insert("lastReadAt".to_string(), serde_json::json!(now()));
        object.insert("readState".to_string(), serde_json::json!(if safe > baseline.max(marked) { "pending" } else { "marked" }));
        object.insert("readError".to_string(), serde_json::json!(""));
    } else {
        object.insert("readState".to_string(), serde_json::json!("error"));
        object.insert("readError".to_string(), serde_json::json!(error.chars().take(500).collect::<String>()));
    }
    transaction
        .execute(
            "UPDATE input_sources SET metadata_json=?1,updated_at=?2 WHERE id=?3",
            params![serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string()), now(), source_id],
        )
        .map_err(|reason| reason.to_string())?;
    transaction.commit().map_err(|reason| reason.to_string())
}

fn validate_tool_name(tool: &str) -> Result<(), String> {
    if ["twitter", "badnews", "haijiao", "missav", "av123"].contains(&tool) { Ok(()) } else { Err("未知工具".to_string()) }
}

pub fn telegram_user_source_for_tool(path: &Path, source_id: i64, tool: &str) -> Result<(String, String), String> {
    validate_tool_name(tool)?;
    let connection = open(path)?;
    connection
        .query_row(
            "SELECT s.external_id,s.name FROM input_sources s JOIN tool_source_bindings b ON b.source_id=s.id WHERE s.id=?1 AND s.kind='telegram_user' AND s.enabled=1 AND b.tool=?2",
            params![source_id, tool],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "该群组/频道未绑定当前工具，或来源已停用".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramToolMessageInput {
    pub message_id: i64,
    #[serde(default)]
    pub message_date: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default = "default_candidate_count")]
    pub candidate_count: i64,
    #[serde(default)]
    pub candidate_preview: String,
}

fn default_candidate_count() -> i64 { -1 }
fn default_page() -> u32 { 1 }
fn default_page_size() -> u32 { 200 }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStoreInput {
    pub source_id: i64,
    pub tool: String,
    #[serde(default)]
    pub messages: Vec<TelegramToolMessageInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStoreResult {
    pub stored_messages: usize,
    pub queued_items: usize,
}

pub fn store_telegram_tool_messages(path: &Path, input: TelegramStoreInput) -> Result<TelegramStoreResult, String> {
    validate_tool_name(&input.tool)?;
    if input.messages.len() > 5_000 { return Err("单次最多落库 5,000 条 Telegram 消息，请分页调用".to_string()); }
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let source_kind: Option<String> = transaction.query_row("SELECT kind FROM input_sources WHERE id=?1 AND enabled=1", params![input.source_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    if !matches!(source_kind.as_deref(), Some("telegram_user") | Some("telegram_bot")) { return Err("Telegram 来源不存在或已停用".to_string()); }
    let bound_tools = {
        let mut statement = transaction.prepare("SELECT tool FROM tool_source_bindings WHERE source_id=?1 ORDER BY tool").map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![input.source_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        rows
    };
    if !bound_tools.iter().any(|tool| tool == &input.tool) { return Err("该来源未绑定当前工具".to_string()); }
    let timestamp = now();
    let mut stored_messages = 0usize;
    let mut queued_items = 0usize;
    {
        let mut message_statement = transaction.prepare_cached(
            "INSERT INTO telegram_messages(source_id,message_id,message_date,message_text,content_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)
             ON CONFLICT(source_id,message_id) DO UPDATE SET message_date=excluded.message_date,message_text=excluded.message_text,content_hash=excluded.content_hash,updated_at=excluded.updated_at",
        ).map_err(|error| error.to_string())?;
        let mut queue_statement = transaction.prepare_cached(
            "INSERT INTO telegram_tool_queue(source_id,message_id,tool,status,candidate_count,candidate_preview,created_at,updated_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?6)
             ON CONFLICT(source_id,message_id,tool) DO UPDATE SET candidate_count=CASE WHEN excluded.candidate_count>=0 THEN excluded.candidate_count ELSE telegram_tool_queue.candidate_count END,candidate_preview=CASE WHEN excluded.candidate_count>=0 THEN excluded.candidate_preview ELSE telegram_tool_queue.candidate_preview END,updated_at=excluded.updated_at",
        ).map_err(|error| error.to_string())?;
        for message in &input.messages {
            if message.message_id <= 0 || message.text.trim().is_empty() { continue; }
            if message.text.len() > 65_536 { return Err(format!("Telegram 消息 {} 文本过长", message.message_id)); }
            stored_messages += message_statement.execute(params![input.source_id, message.message_id, &message.message_date, &message.text, &message.content_hash, &timestamp]).map_err(|error| error.to_string())?;
            for tool in &bound_tools {
                let is_current = tool == &input.tool;
                let candidate_count = if is_current { message.candidate_count.max(0) } else { -1 };
                let preview = if is_current { message.candidate_preview.chars().take(1_000).collect::<String>() } else { String::new() };
                queued_items += queue_statement.execute(params![input.source_id, message.message_id, tool, candidate_count, preview, &timestamp]).map_err(|error| error.to_string())?;
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(TelegramStoreResult { stored_messages, queued_items })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramQueueQuery {
    pub tool: String,
    #[serde(default)]
    pub source_ids: Vec<i64>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub start_at: String,
    #[serde(default)]
    pub end_at: String,
    #[serde(default)]
    pub candidate_only: bool,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramToolMessage {
    pub key: String,
    pub source_id: i64,
    pub source_name: String,
    pub message_id: i64,
    pub message_date: String,
    pub text: String,
    pub status: String,
    pub candidate_count: i64,
    pub candidate_preview: String,
    pub run_id: Option<i64>,
    pub error: String,
    pub processed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramToolMessagePage {
    pub data: Vec<TelegramToolMessage>,
    pub page: u32,
    pub page_size: u32,
    pub last_page: u32,
    pub total: i64,
    pub status_counts: HashMap<String, i64>,
}

fn telegram_queue_filter(input: &TelegramQueueQuery, include_status: bool) -> Result<(String, Vec<Value>), String> {
    validate_tool_name(&input.tool)?;
    let mut conditions = vec!["q.tool=?".to_string()];
    let mut values = vec![Value::Text(input.tool.clone())];
    if !input.source_ids.is_empty() {
        let valid = input.source_ids.iter().copied().filter(|id| *id > 0).collect::<Vec<_>>();
        if valid.is_empty() { return Err("来源 ID 无效".to_string()); }
        conditions.push(format!("q.source_id IN ({})", vec!["?"; valid.len()].join(",")));
        values.extend(valid.into_iter().map(Value::Integer));
    }
    if include_status && !input.status.trim().is_empty() {
        let status = input.status.trim();
        if !["pending", "processed", "processed_empty", "ignored", "error"].contains(&status) { return Err("Telegram 工具队列状态无效".to_string()); }
        conditions.push("q.status=?".to_string());
        values.push(Value::Text(status.to_string()));
    }
    if input.candidate_only {
        conditions.push("q.candidate_count>0".to_string());
    }
    let search = input.search.trim();
    if !search.is_empty() {
        conditions.push("(s.name LIKE ? OR m.message_text LIKE ? OR q.candidate_preview LIKE ? OR q.error LIKE ? OR CAST(m.message_id AS TEXT) LIKE ?)".to_string());
        let pattern = format!("%{search}%");
        values.extend((0..5).map(|_| Value::Text(pattern.clone())));
    }
    let start_at = input.start_at.trim();
    let end_at = input.end_at.trim();
    if !start_at.is_empty() {
        chrono::DateTime::parse_from_rfc3339(start_at).map_err(|_| "消息筛选开始时间无效".to_string())?;
        conditions.push("julianday(m.message_date)>=julianday(?)".to_string());
        values.push(Value::Text(start_at.to_string()));
    }
    if !end_at.is_empty() {
        chrono::DateTime::parse_from_rfc3339(end_at).map_err(|_| "消息筛选结束时间无效".to_string())?;
        conditions.push("julianday(m.message_date)<=julianday(?)".to_string());
        values.push(Value::Text(end_at.to_string()));
    }
    if !start_at.is_empty() && !end_at.is_empty() {
        let start = chrono::DateTime::parse_from_rfc3339(start_at).map_err(|_| "消息筛选开始时间无效".to_string())?;
        let end = chrono::DateTime::parse_from_rfc3339(end_at).map_err(|_| "消息筛选结束时间无效".to_string())?;
        if start > end { return Err("消息筛选开始时间不能晚于结束时间".to_string()); }
    }
    Ok((conditions.join(" AND "), values))
}

fn telegram_tool_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TelegramToolMessage> {
    let source_id: i64 = row.get(0)?;
    let message_id: i64 = row.get(2)?;
    Ok(TelegramToolMessage {
        key: format!("{source_id}:{message_id}"), source_id, source_name: row.get(1)?, message_id,
        message_date: row.get(3)?, text: row.get(4)?, status: row.get(5)?, candidate_count: row.get(6)?,
        candidate_preview: row.get(7)?, run_id: row.get(8)?, error: row.get(9)?, processed_at: row.get(10)?, updated_at: row.get(11)?,
    })
}

pub fn query_telegram_tool_messages(path: &Path, input: TelegramQueueQuery) -> Result<TelegramToolMessagePage, String> {
    let connection = open(path)?;
    let page = input.page.max(1);
    let page_size = input.page_size.clamp(20, 500);
    let (conditions, values) = telegram_queue_filter(&input, true)?;
    let total: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM telegram_tool_queue q JOIN telegram_messages m ON m.source_id=q.source_id AND m.message_id=q.message_id JOIN input_sources s ON s.id=q.source_id WHERE {conditions}"),
        params_from_iter(values.iter()), |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let mut row_values = values.clone();
    row_values.push(Value::Integer(page_size as i64));
    row_values.push(Value::Integer(((page - 1) * page_size) as i64));
    let sql = format!("SELECT q.source_id,s.name,m.message_id,m.message_date,m.message_text,q.status,q.candidate_count,q.candidate_preview,q.run_id,q.error,q.processed_at,q.updated_at FROM telegram_tool_queue q JOIN telegram_messages m ON m.source_id=q.source_id AND m.message_id=q.message_id JOIN input_sources s ON s.id=q.source_id WHERE {conditions} ORDER BY m.message_date DESC,m.message_id DESC LIMIT ? OFFSET ?");
    let data = {
        let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(row_values.iter()), telegram_tool_message_from_row).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        rows
    };
    let (base_conditions, base_values) = telegram_queue_filter(&input, false)?;
    let status_counts = {
        let mut statement = connection.prepare(&format!("SELECT q.status,COUNT(*) FROM telegram_tool_queue q JOIN telegram_messages m ON m.source_id=q.source_id AND m.message_id=q.message_id JOIN input_sources s ON s.id=q.source_id WHERE {base_conditions} GROUP BY q.status")).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(base_values.iter()), |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?.collect::<Result<HashMap<_, _>, _>>().map_err(|error| error.to_string())?;
        rows
    };
    let last_page = ((total.max(1) as u32) + page_size - 1) / page_size;
    Ok(TelegramToolMessagePage { data, page, page_size, last_page, total, status_counts })
}

pub fn telegram_tool_message_keys(path: &Path, input: TelegramQueueQuery) -> Result<Vec<String>, String> {
    let connection = open(path)?;
    let (conditions, values) = telegram_queue_filter(&input, true)?;
    let mut statement = connection.prepare(&format!("SELECT q.source_id,q.message_id FROM telegram_tool_queue q JOIN telegram_messages m ON m.source_id=q.source_id AND m.message_id=q.message_id JOIN input_sources s ON s.id=q.source_id WHERE {conditions} ORDER BY m.message_date DESC,m.message_id DESC LIMIT 100000")).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params_from_iter(values.iter()), |row| Ok(format!("{}:{}", row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(rows)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessageKey { pub source_id: i64, pub message_id: i64 }

pub fn get_telegram_tool_messages(path: &Path, tool: &str, keys: &[TelegramMessageKey]) -> Result<Vec<TelegramToolMessage>, String> {
    validate_tool_name(tool)?;
    if keys.is_empty() || keys.len() > 20_000 { return Err("一次请选择 1 到 20,000 条消息".to_string()); }
    let connection = open(path)?;
    let mut statement = connection.prepare("SELECT q.source_id,s.name,m.message_id,m.message_date,m.message_text,q.status,q.candidate_count,q.candidate_preview,q.run_id,q.error,q.processed_at,q.updated_at FROM telegram_tool_queue q JOIN telegram_messages m ON m.source_id=q.source_id AND m.message_id=q.message_id JOIN input_sources s ON s.id=q.source_id WHERE q.tool=?1 AND q.source_id=?2 AND q.message_id=?3").map_err(|error| error.to_string())?;
    let mut output = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(row) = statement.query_row(params![tool, key.source_id, key.message_id], telegram_tool_message_from_row).optional().map_err(|error| error.to_string())? { output.push(row); }
    }
    if output.len() != keys.len() { return Err("部分 Telegram 消息不存在当前工具队列中，请刷新后重试".to_string()); }
    Ok(output)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessageCreateInput {
    pub tool: String,
    pub source_id: i64,
    #[serde(default)]
    pub message_date: String,
    pub text: String,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub candidate_count: i64,
    #[serde(default)]
    pub candidate_preview: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessageUpdateInput {
    pub tool: String,
    pub source_id: i64,
    pub message_id: i64,
    pub field: String,
    pub value: String,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub candidate_count: i64,
    #[serde(default)]
    pub candidate_preview: String,
}

fn validate_telegram_message_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() { return Err("消息正文不能为空".to_string()); }
    if text.len() > 65_536 { return Err("Telegram 消息正文不能超过 65,536 个字符".to_string()); }
    Ok(())
}

fn validate_telegram_message_date(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() { return Ok(now()); }
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "消息时间必须是有效的 RFC3339 时间".to_string())?;
    Ok(value.to_string())
}

fn ensure_source_bound_to_tool(connection: &Connection, source_id: i64, tool: &str) -> Result<(), String> {
    let exists = connection.query_row(
        "SELECT 1 FROM input_sources s JOIN tool_source_bindings b ON b.source_id=s.id WHERE s.id=?1 AND s.enabled=1 AND s.kind IN ('telegram_user','telegram_bot') AND b.tool=?2",
        params![source_id, tool],
        |_| Ok(()),
    ).optional().map_err(|error| error.to_string())?.is_some();
    if exists { Ok(()) } else { Err("该 Telegram 来源未绑定当前工具，或来源已停用".to_string()) }
}

pub fn create_telegram_tool_message(path: &Path, input: TelegramMessageCreateInput) -> Result<TelegramToolMessage, String> {
    validate_tool_name(&input.tool)?;
    validate_telegram_message_text(&input.text)?;
    let message_date = validate_telegram_message_date(&input.message_date)?;
    let mut connection = open(path)?;
    ensure_source_bound_to_tool(&connection, input.source_id, &input.tool)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let minimum: i64 = transaction.query_row(
        "SELECT COALESCE(MIN(message_id),0) FROM telegram_messages WHERE source_id=?1",
        params![input.source_id],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let message_id = if minimum < 0 { minimum - 1 } else { -1 };
    let timestamp = now();
    transaction.execute(
        "INSERT INTO telegram_messages(source_id,message_id,message_date,message_text,content_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
        params![input.source_id, message_id, message_date, input.text.trim(), input.content_hash, timestamp],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO telegram_tool_queue(source_id,message_id,tool,status,candidate_count,candidate_preview,created_at,updated_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?6)",
        params![input.source_id, message_id, input.tool, input.candidate_count.max(0), input.candidate_preview.chars().take(1_000).collect::<String>(), timestamp],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let key = TelegramMessageKey { source_id: input.source_id, message_id };
    get_telegram_tool_messages(path, &input.tool, &[key])?.pop().ok_or_else(|| "新增消息未能重新读取".to_string())
}

pub fn update_telegram_tool_message(path: &Path, input: TelegramMessageUpdateInput) -> Result<(), String> {
    validate_tool_name(&input.tool)?;
    let mut connection = open(path)?;
    ensure_source_bound_to_tool(&connection, input.source_id, &input.tool)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let exists = transaction.query_row(
        "SELECT 1 FROM telegram_tool_queue WHERE tool=?1 AND source_id=?2 AND message_id=?3",
        params![input.tool, input.source_id, input.message_id],
        |_| Ok(()),
    ).optional().map_err(|error| error.to_string())?.is_some();
    if !exists { return Err("要修改的消息已不在当前工具中".to_string()); }
    let timestamp = now();
    match input.field.as_str() {
        "messageDate" => {
            let value = validate_telegram_message_date(&input.value)?;
            transaction.execute(
                "UPDATE telegram_messages SET message_date=?1,updated_at=?2 WHERE source_id=?3 AND message_id=?4",
                params![value, timestamp, input.source_id, input.message_id],
            ).map_err(|error| error.to_string())?;
        }
        "text" => {
            validate_telegram_message_text(&input.value)?;
            transaction.execute(
                "UPDATE telegram_messages SET message_text=?1,content_hash=?2,updated_at=?3 WHERE source_id=?4 AND message_id=?5",
                params![input.value.trim(), input.content_hash, timestamp, input.source_id, input.message_id],
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE telegram_tool_queue SET status='pending',run_id=NULL,error='',processed_at='',candidate_count=CASE WHEN tool=?1 THEN ?2 ELSE -1 END,candidate_preview=CASE WHEN tool=?1 THEN ?3 ELSE '' END,updated_at=?4 WHERE source_id=?5 AND message_id=?6",
                params![input.tool, input.candidate_count.max(0), input.candidate_preview.chars().take(1_000).collect::<String>(), timestamp, input.source_id, input.message_id],
            ).map_err(|error| error.to_string())?;
        }
        _ => return Err("消息表只允许修改时间和正文".to_string()),
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn delete_telegram_tool_messages(path: &Path, tool: &str, keys: &[TelegramMessageKey]) -> Result<usize, String> {
    validate_tool_name(tool)?;
    if keys.is_empty() || keys.len() > 100_000 { return Err("未选择消息或选择数量过大".to_string()); }
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let mut changed = 0usize;
    {
        let mut delete_queue = transaction.prepare_cached("DELETE FROM telegram_tool_queue WHERE tool=?1 AND source_id=?2 AND message_id=?3").map_err(|error| error.to_string())?;
        let mut cleanup_message = transaction.prepare_cached("DELETE FROM telegram_messages WHERE source_id=?1 AND message_id=?2 AND NOT EXISTS (SELECT 1 FROM telegram_tool_queue WHERE source_id=?1 AND message_id=?2)").map_err(|error| error.to_string())?;
        for key in keys {
            changed += delete_queue.execute(params![tool, key.source_id, key.message_id]).map_err(|error| error.to_string())?;
            cleanup_message.execute(params![key.source_id, key.message_id]).map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramQueueResolveInput { pub tool: String, pub keys: Vec<TelegramMessageKey>, pub status: String }

pub fn resolve_telegram_tool_messages(path: &Path, input: TelegramQueueResolveInput) -> Result<usize, String> {
    validate_tool_name(&input.tool)?;
    if !["pending", "ignored"].contains(&input.status.as_str()) { return Err("只能把队列记录设为待处理或已忽略".to_string()); }
    if input.keys.is_empty() || input.keys.len() > 100_000 { return Err("未选择消息或选择数量过大".to_string()); }
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let timestamp = now();
    let mut changed = 0usize;
    {
        let mut statement = transaction.prepare_cached("UPDATE telegram_tool_queue SET status=?1,run_id=CASE WHEN ?1='pending' THEN NULL ELSE run_id END,error='',processed_at=CASE WHEN ?1='pending' THEN '' ELSE ?2 END,updated_at=?2 WHERE tool=?3 AND source_id=?4 AND message_id=?5").map_err(|error| error.to_string())?;
        for key in &input.keys { changed += statement.execute(params![&input.status, &timestamp, &input.tool, key.source_id, key.message_id]).map_err(|error| error.to_string())?; }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessageRunInput { pub tool: String, pub keys: Vec<TelegramMessageKey>, pub run: CreateRunInput }

pub fn create_telegram_message_run(path: &Path, input: TelegramMessageRunInput) -> Result<i64, String> {
    validate_tool_name(&input.tool)?;
    if input.run.tool != input.tool { return Err("Telegram 队列工具与任务工具不一致".to_string()); }
    if input.keys.is_empty() || input.keys.len() > 20_000 { return Err("一次请处理 1 到 20,000 条消息".to_string()); }
    validate_run(&input.run)?;
    let mut connection = open(path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    for key in &input.keys {
        let exists = transaction.query_row("SELECT 1 FROM telegram_tool_queue WHERE tool=?1 AND source_id=?2 AND message_id=?3", params![&input.tool, key.source_id, key.message_id], |_| Ok(())).optional().map_err(|error| error.to_string())?.is_some();
        if !exists { return Err("选中消息已不在当前工具队列中".to_string()); }
    }
    let timestamp = now();
    let (run_id, status) = if input.run.results.is_empty() { (0, "processed_empty") } else { (insert_run(&transaction, &input.run, &timestamp, None)?, "processed") };
    {
        let mut statement = transaction.prepare_cached("UPDATE telegram_tool_queue SET status=?1,run_id=?2,error='',processed_at=?3,updated_at=?3 WHERE tool=?4 AND source_id=?5 AND message_id=?6").map_err(|error| error.to_string())?;
        for key in &input.keys { statement.execute(params![status, if run_id > 0 { Some(run_id) } else { None }, &timestamp, &input.tool, key.source_id, key.message_id]).map_err(|error| error.to_string())?; }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(run_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramToolCursor { pub oldest_message_id: i64, pub newest_message_id: i64, pub source_checkpoint: i64 }

pub fn telegram_tool_cursor(path: &Path, tool: &str, source_id: i64) -> Result<TelegramToolCursor, String> {
    validate_tool_name(tool)?;
    let connection = open(path)?;
    let (oldest_message_id, newest_message_id): (i64, i64) = connection.query_row("SELECT COALESCE(MIN(message_id),0),COALESCE(MAX(message_id),0) FROM telegram_tool_queue WHERE tool=?1 AND source_id=?2", params![tool, source_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
    let checkpoint: String = connection.query_row("SELECT checkpoint FROM input_sources WHERE id=?1", params![source_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.ok_or_else(|| "Telegram 来源不存在".to_string())?;
    Ok(TelegramToolCursor { oldest_message_id, newest_message_id, source_checkpoint: checkpoint.parse().unwrap_or(0) })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramLoadSessionInput {
    pub tool: String, pub source_id: i64, pub mode: String, pub requested_count: i64,
    pub scanned_count: i64, pub loaded_count: i64, pub next_before_id: i64, pub next_after_id: i64,
    pub status: String, #[serde(default)] pub error: String,
}

pub fn record_telegram_load_session(path: &Path, input: TelegramLoadSessionInput) -> Result<i64, String> {
    validate_tool_name(&input.tool)?;
    if !["latest", "range", "continue", "incremental"].contains(&input.mode.as_str()) { return Err("Telegram 加载模式无效".to_string()); }
    if !["completed", "stopped", "error"].contains(&input.status.as_str()) { return Err("Telegram 加载会话状态无效".to_string()); }
    let connection = open(path)?;
    let timestamp = now();
    connection.execute("INSERT INTO telegram_load_sessions(tool,source_id,mode,requested_count,scanned_count,loaded_count,next_before_id,next_after_id,status,error,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![input.tool,input.source_id,input.mode,input.requested_count.max(0),input.scanned_count.max(0),input.loaded_count.max(0),input.next_before_id.max(0),input.next_after_id.max(0),input.status,input.error.chars().take(500).collect::<String>(),timestamp]).map_err(|error| error.to_string())?;
    Ok(connection.last_insert_rowid())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxTask {
    pub id: i64,
    pub run_id: i64,
    pub source_id: Option<i64>,
    pub source_name: String,
    pub tool: String,
    pub stage: String,
    pub title: String,
    pub summary: String,
    pub error: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn list_inbox(path: &Path, stage: &str, search: &str, limit: u32) -> Result<Vec<InboxTask>, String> {
    let connection = open(path)?;
    let pattern = format!("%{}%", search.trim());
    let mut statement = connection.prepare("SELECT i.id,i.run_id,i.source_id,COALESCE(s.name,''),i.tool,i.stage,i.title,i.summary,i.error,i.created_at,i.updated_at FROM task_inbox i LEFT JOIN input_sources s ON s.id=i.source_id WHERE (?1='' OR i.stage=?1) AND (?2='%%' OR i.title LIKE ?2 OR i.summary LIKE ?2 OR i.error LIKE ?2 OR COALESCE(s.name,'') LIKE ?2) ORDER BY i.id DESC LIMIT ?3").map_err(|error| error.to_string())?;
    let output = statement.query_map(params![stage, pattern, limit.clamp(1, 5000)], |row| Ok(InboxTask { id: row.get(0)?, run_id: row.get(1)?, source_id: row.get(2)?, source_name: row.get(3)?, tool: row.get(4)?, stage: row.get(5)?, title: row.get(6)?, summary: row.get(7)?, error: row.get(8)?, created_at: row.get(9)?, updated_at: row.get(10)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
    Ok(output)
}

pub fn update_inbox_stage(path: &Path, id: i64, stage: &str) -> Result<(), String> {
    let allowed = ["new", "filtered", "website_action", "review", "exception", "completed"];
    if !allowed.contains(&stage) { return Err("未知处理阶段".to_string()); }
    let connection = open(path)?;
    let changed = connection.execute("UPDATE task_inbox SET stage=?1,updated_at=?2 WHERE id=?3", params![stage, now(), id]).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("处理中心任务不存在".to_string()); }
    Ok(())
}

pub fn record_script_generation(path: &Path, run_id: Option<i64>, template_version: &str, code_count: u32) -> Result<(), String> {
    if template_version.trim().is_empty() || code_count == 0 { return Err("脚本生成记录缺少模板版本或番号数量".to_string()); }
    let connection = open(path)?;
    if let Some(id) = run_id {
        let exists = connection.query_row("SELECT 1 FROM content_runs WHERE id=?1 AND tool='missav'", params![id], |_| Ok(())).optional().map_err(|error| error.to_string())?.is_some();
        if !exists { return Err("MissAV 任务不存在，无法记录脚本生成历史".to_string()); }
    }
    connection.execute("INSERT INTO script_generations(run_id,template_version,code_count,created_at) VALUES (?1,?2,?3,?4)", params![run_id, template_version.trim(), code_count, now()]).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_setting(path: &Path, key: &str) -> Result<Option<serde_json::Value>, String> {
    let connection = open(path)?;
    let value: Option<String> = connection
        .query_row("SELECT value_json FROM app_settings WHERE key=?1", params![key], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(value.map(parse_json))
}

pub fn set_setting(path: &Path, key: &str, value: &serde_json::Value) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 120 {
        return Err("设置键无效".to_string());
    }
    let connection = open(path)?;
    connection
        .execute(
            "INSERT INTO app_settings(key,value_json,updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![key, serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()), now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: i64,
    pub level: String,
    pub category: String,
    pub message: String,
    pub details: serde_json::Value,
    pub created_at: String,
}

fn redact(value: &str) -> String {
    let mut output = redact_telegram_bot_url(value);
    for marker in ["token", "api_hash", "password", "authorization", "bearer"] {
        if output.to_ascii_lowercase().contains(marker) {
            output = "[已隐藏敏感详情]".to_string();
            break;
        }
    }
    output
}

fn redact_telegram_bot_url(value: &str) -> String {
    const PREFIX: &str = "https://api.telegram.org/bot";
    let mut output = value.to_string();
    let mut search_from = 0;
    while let Some(relative_start) = output[search_from..].find(PREFIX) {
        let secret_start = search_from + relative_start + PREFIX.len();
        let secret_end = output[secret_start..]
            .find('/')
            .map(|offset| secret_start + offset)
            .unwrap_or(output.len());
        output.replace_range(secret_start..secret_end, "[REDACTED]");
        search_from = secret_start + "[REDACTED]".len();
    }
    output
}

fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(map.iter().map(|(key, value)| {
            let lower = key.to_ascii_lowercase();
            let sensitive = ["token", "api_hash", "password", "authorization", "bearer", "session"].iter().any(|marker| lower.contains(marker));
            (key.clone(), if sensitive { serde_json::Value::String("[REDACTED]".to_string()) } else { redact_json(value) })
        }).collect()),
        serde_json::Value::Array(values) => serde_json::Value::Array(values.iter().map(redact_json).collect()),
        serde_json::Value::String(value) => serde_json::Value::String(redact(value)),
        other => other.clone(),
    }
}

pub fn append_log(path: &Path, level: &str, category: &str, message: &str, details: &serde_json::Value) -> Result<(), String> {
    let connection = open(path)?;
    connection
        .execute(
            "INSERT INTO app_logs(level,category,message,details_json,created_at) VALUES (?1,?2,?3,?4,?5)",
            params![
                level,
                category,
                redact(message),
                serde_json::to_string(&redact_json(details)).unwrap_or_else(|_| "{}".to_string()),
                now()
            ],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM app_logs WHERE id NOT IN (SELECT id FROM app_logs ORDER BY id DESC LIMIT 20000)", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_logs(path: &Path, limit: u32, level: &str, search: &str) -> Result<Vec<LogEntry>, String> {
    let connection = open(path)?;
    let search = format!("%{}%", search.trim());
    let mut statement = connection
        .prepare(
            "SELECT id,level,category,message,details_json,created_at FROM app_logs
             WHERE (?1='' OR level=?1) AND (?2='%%' OR message LIKE ?2 OR category LIKE ?2)
             ORDER BY id DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![level, search, limit.clamp(1, 5000)], |row| {
            let details: String = row.get(4)?;
            Ok(LogEntry {
                id: row.get(0)?,
                level: row.get(1)?,
                category: row.get(2)?,
                message: redact(&row.get::<_, String>(3)?),
                details: redact_json(&parse_json(details)),
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub modified_at: String,
}

pub fn create_backup(path: &Path, label: Option<&str>) -> Result<BackupInfo, String> {
    let parent = path.parent().ok_or_else(|| "数据库目录无效".to_string())?;
    let backup_dir = parent.join("backups-v05");
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    let safe_label: String = label
        .unwrap_or("manual")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(40)
        .collect();
    let name = format!("v05-{}-{}.sqlite", Utc::now().format("%Y%m%d-%H%M%S-%3f"), safe_label);
    let target = backup_dir.join(name);
    let connection = open(path)?;
    connection
        .execute("VACUUM INTO ?1", params![target.display().to_string()])
        .map_err(|error| format!("创建备份失败：{error}"))?;
    backup_info(&target)
}

fn backup_info(path: &Path) -> Result<BackupInfo, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().ok().map(chrono::DateTime::<Utc>::from).map(|time| time.to_rfc3339()).unwrap_or_default();
    Ok(BackupInfo {
        path: path.display().to_string(),
        name: path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_string(),
        bytes: metadata.len(),
        modified_at: modified,
    })
}

pub fn list_backups(path: &Path) -> Result<Vec<BackupInfo>, String> {
    let directory = path.parent().ok_or_else(|| "数据库目录无效".to_string())?.join("backups-v05");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("sqlite"))
        .filter_map(|entry| backup_info(&entry.path()).ok())
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.name.cmp(&left.name));
    Ok(items)
}

pub fn restore_backup(path: &Path, backup_path: &Path) -> Result<(), String> {
    if !backup_path.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let backup_root = path.parent().ok_or_else(|| "数据库目录无效".to_string())?.join("backups-v05");
    let canonical = backup_path.canonicalize().map_err(|error| error.to_string())?;
    let canonical_root = backup_root.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("只允许恢复由 v0.5 创建的备份".to_string());
    }
    {
        let check = Connection::open_with_flags(&canonical, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;
        let integrity: String = check.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        if integrity != "ok" {
            return Err("备份完整性检查未通过".to_string());
        }
    }
    create_backup(path, Some("before-restore"))?;
    for suffix in ["-wal", "-shm"] {
        let companion = PathBuf::from(format!("{}{}", path.display(), suffix));
        if companion.exists() {
            let _ = fs::remove_file(companion);
        }
    }
    fs::copy(canonical, path).map_err(|error| format!("恢复备份失败：{error}"))?;
    Ok(())
}

pub fn relocate_database(path: &Path, target_directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(target_directory).map_err(|error| format!("创建目标数据库目录失败：{error}"))?;
    let directory = target_directory.canonicalize().map_err(|error| error.to_string())?;
    let target = directory.join("tg-content-toolbox-v05.sqlite");
    if target == path { return Err("目标位置与当前数据库相同".to_string()); }
    if target.exists() { return Err("目标目录已存在同名数据库；为避免覆盖，请选择空目录或先改名".to_string()); }
    create_backup(path, Some("before-relocate"))?;
    let connection = open(path)?;
    connection.execute("VACUUM INTO ?1", params![target.display().to_string()]).map_err(|error| format!("复制数据库失败：{error}"))?;
    let check = Connection::open_with_flags(&target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    let integrity: String = check.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if integrity != "ok" { let _ = fs::remove_file(&target); return Err("新数据库完整性检查失败，已取消切换".to_string()); }
    Ok(target)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationResult {
    pub source_path: String,
    pub archived_tables: usize,
    pub archived_rows: i64,
    pub missav_records: usize,
    pub av123_records: usize,
    pub history_runs: usize,
    pub telegram_sources: usize,
    pub telegram_fingerprints: usize,
    pub backup_path: String,
}

fn quoted(value: &str) -> String { format!("\"{}\"", value.replace('"', "\"\"")) }
fn archive_name(value: &str) -> String {
    format!("legacy_v045_{}", value.chars().map(|character| if character.is_ascii_alphanumeric() || character == '_' { character } else { '_' }).collect::<String>())
}

fn table_exists(connection: &Connection, name: &str) -> bool {
    connection.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", params![name], |_| Ok(())).optional().ok().flatten().is_some()
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut statement) = connection.prepare(&format!("PRAGMA table_info({})", quoted(table))) else { return false; };
    let Ok(columns) = statement.query_map([], |row| row.get::<_, String>(1)) else { return false; };
    let found = columns.filter_map(Result::ok).any(|candidate| candidate == column);
    found
}

fn legacy_source_kind(source_type: &str) -> String {
    if source_type.to_ascii_lowercase().contains("bot") {
        "telegram_bot".to_string()
    } else {
        "telegram_user".to_string()
    }
}

fn recovered_legacy_bindings(source_label: &str) -> Vec<String> {
    // v0.4.5 saved per-tool bindings in Chromium Local Storage rather than SQLite.
    // These label rules reproduce the bindings recovered from that store while
    // leaving ambiguous sources unbound for explicit user review.
    let label = source_label.to_ascii_lowercase();
    if label.contains("bad.news") {
        vec!["badnews".to_string()]
    } else if source_label.contains("海角") {
        vec!["haijiao".to_string()]
    } else if source_label.contains("福利姬") {
        vec!["twitter".to_string()]
    } else if source_label.contains("番号待提取") {
        vec!["missav".to_string()]
    } else {
        Vec::new()
    }
}

pub fn migrate_legacy(path: &Path, source: &Path, replace: bool) -> Result<LegacyMigrationResult, String> {
    if !source.is_file() { return Err("旧数据库文件不存在".to_string()); }
    if source.canonicalize().ok() == path.canonicalize().ok() { return Err("不能把 v0.5 当前数据库当作旧库迁移".to_string()); }
    let old = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|error| format!("只读打开旧库失败：{error}"))?;
    old.execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;").map_err(|error| error.to_string())?;
    let integrity: String = old.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if integrity.to_ascii_lowercase() != "ok" { return Err(format!("旧库完整性检查未通过：{integrity}")); }
    let backup = create_backup(path, Some("before-v045-migration"))?;
    let mut current = open(path)?;
    if !replace {
        let done: Option<String> = current.query_row("SELECT value_json FROM app_settings WHERE key='migration.v045.completed'", [], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        if done.is_some() { return Err("已经完成过一次 v0.4.5 迁移；如需覆盖，请在迁移页选择“重新归档并覆盖映射”".to_string()); }
    }

    if replace {
        let clear = current.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        clear.execute_batch(
            "DELETE FROM script_generations;
             DELETE FROM sync_transactions;
             DELETE FROM task_inbox;
             DELETE FROM content_runs;
             DELETE FROM permanent_records;
             DELETE FROM input_sources;
             DELETE FROM remote_mirrors;
             DELETE FROM app_logs;
             DELETE FROM sqlite_sequence WHERE name IN ('content_runs','content_results','permanent_records','input_sources','app_logs','remote_mirrors','sync_transactions','task_inbox','script_generations');
             DELETE FROM app_settings WHERE key='migration.v045.completed';"
        ).map_err(|error| format!("清空 v0.5 当前业务数据失败，已保留迁移前备份：{error}"))?;
        for obsolete in ["prototype_task_items", "prototype_tasks", "prototype_records"] {
            if table_exists(&clear, obsolete) { clear.execute(&format!("DELETE FROM {}", quoted(obsolete)), []).map_err(|error| format!("清空旧原型表 {obsolete} 失败：{error}"))?; }
        }
        clear.commit().map_err(|error| format!("提交 v0.5 清空事务失败：{error}"))?;
    }

    let mut table_statement = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(|error| error.to_string())?;
    let table_names = table_statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let transaction = current.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let mut archived_rows = 0_i64;
    for table in &table_names {
        let target = archive_name(table);
        transaction.execute_batch(&format!("DROP TABLE IF EXISTS {};", quoted(&target))).map_err(|error| error.to_string())?;
        let mut columns_statement = old.prepare(&format!("PRAGMA table_info({})", quoted(table))).map_err(|error| error.to_string())?;
        let columns = columns_statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        if columns.is_empty() { continue; }
        let definitions = columns.iter().map(|column| format!("{} BLOB", quoted(column))).collect::<Vec<_>>().join(",");
        transaction.execute_batch(&format!("CREATE TABLE {} ({definitions});", quoted(&target))).map_err(|error| error.to_string())?;
        let placeholders = (1..=columns.len()).map(|index| format!("?{index}")).collect::<Vec<_>>().join(",");
        let insert_sql = format!("INSERT INTO {} VALUES ({placeholders})", quoted(&target));
        let mut insert = transaction.prepare_cached(&insert_sql).map_err(|error| error.to_string())?;
        let mut select = old.prepare(&format!("SELECT * FROM {}", quoted(table))).map_err(|error| error.to_string())?;
        let mut rows = select.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let values = (0..columns.len()).map(|index| row.get::<_, Value>(index)).collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            insert.execute(rusqlite::params_from_iter(values)).map_err(|error| error.to_string())?;
            archived_rows += 1;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let mut missav_records = 0_usize;
    let mut av123_records = 0_usize;
    if table_exists(&old, "codes") {
        let actress_expression = if table_exists(&old, "actress_tags") && table_exists(&old, "actress_code_map") { "COALESCE((SELECT group_concat(a.tag_name, char(31)) FROM actress_code_map m JOIN actress_tags a ON a.id=m.actress_id WHERE m.code_id=c.id),'')" } else { "''" };
        let genre_expression = if table_exists(&old, "genre_tags") && table_exists(&old, "code_genres") { "COALESCE((SELECT group_concat(g.name, char(31)) FROM code_genres m JOIN genre_tags g ON g.id=m.genre_id WHERE m.code_id=c.id),'')" } else { "''" };
        let sql = format!("SELECT c.code,COALESCE(c.best_url,''),COALESCE(c.status,'pending'),COALESCE(c.source_url,''),COALESCE(c.missav_error,''),COALESCE(c.av123_url,''),COALESCE(c.av123_status,'pending'),COALESCE(c.av123_error,''),COALESCE(c.raindrop_tags,''),COALESCE(c.raindrop_remote_id,''),COALESCE(c.raindrop_collection_id,-1),COALESCE(c.created_at,''),COALESCE(c.updated_at,''),{actress_expression},{genre_expression} FROM codes c ORDER BY c.id");
        let mut statement = old.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,row.get::<_, String>(4)?,row.get::<_, String>(5)?,row.get::<_, String>(6)?,row.get::<_, String>(7)?,row.get::<_, String>(8)?,row.get::<_, String>(9)?,row.get::<_, i64>(10)?,row.get::<_, String>(11)?,row.get::<_, String>(12)?,row.get::<_, String>(13)?,row.get::<_, String>(14)?))).map_err(|error| error.to_string())?;
        let timestamp = now();
        let connection = open(path)?;
        let mut insert = connection.prepare("INSERT INTO permanent_records(tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,raindrop_remote_id,raindrop_collection_id,metadata_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(tool,record_key) DO UPDATE SET primary_value=excluded.primary_value,secondary_value=excluded.secondary_value,status=excluded.status,tags_json=excluded.tags_json,actress_tags_json=excluded.actress_tags_json,genre_tags_json=excluded.genre_tags_json,source_url=excluded.source_url,missav_url=excluded.missav_url,av123_url=excluded.av123_url,raindrop_remote_id=excluded.raindrop_remote_id,raindrop_collection_id=excluded.raindrop_collection_id,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at").map_err(|error| error.to_string())?;
        for row in rows {
            let (code,best,status,source_url,missav_error,av_url,av_status,av_error,remote_tags,remote_id,collection_id,created,updated,actress_raw,genre_raw) = row.map_err(|error| error.to_string())?;
            let actresses = actress_raw.split('\u{1f}').filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
            let genres = genre_raw.split('\u{1f}').filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
            let mut tags = remote_tags.split(',').map(str::trim).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>(); tags.extend(actresses.clone()); tags.extend(genres.clone()); tags.sort(); tags.dedup();
            let remote_number = remote_id.parse::<i64>().ok(); let collection = if collection_id >= -1 { Some(collection_id) } else { None };
            let created_at = if created.is_empty() { timestamp.clone() } else { created }; let updated_at = if updated.is_empty() { timestamp.clone() } else { updated };
            let key = code.to_ascii_lowercase().replace('-', "");
            insert.execute(params!["missav",key,code,best,status,serde_json::to_string(&tags).unwrap(),serde_json::to_string(&actresses).unwrap(),serde_json::to_string(&genres).unwrap(),source_url,best,av_url,remote_number,collection,serde_json::json!({"legacyMissavError":missav_error,"migratedFrom":"v0.4.5"}).to_string(),created_at,updated_at]).map_err(|error| error.to_string())?;
            missav_records += 1;
            insert.execute(params!["av123",key,code,av_url,av_status,"[]","[]","[]","","",av_url,Option::<i64>::None,Option::<i64>::None,serde_json::json!({"legacyAv123Error":av_error,"migratedFrom":"v0.4.5"}).to_string(),timestamp,timestamp]).map_err(|error| error.to_string())?;
            av123_records += 1;
        }
    }

    let mut telegram_sources = 0_usize;
    let mut telegram_fingerprints = 0_usize;
    let mut legacy_source_ids = HashMap::<i64, i64>::new();
    if table_exists(&old, "telegram_sources") {
        let account_key = if column_exists(&old, "telegram_sources", "account_key") { "COALESCE(account_key,'')" } else { "''" };
        let account_label = if column_exists(&old, "telegram_sources", "account_label") { "COALESCE(account_label,'')" } else { "''" };
        let source_sql = format!("SELECT id,source_key,source_type,{account_key},{account_label},COALESCE(source_label,''),COALESCE(chat_key,''),COALESCE(chat_type,''),COALESCE(checkpoint_message_id,0),COALESCE(status,'idle'),COALESCE(last_sync_at,'') FROM telegram_sources ORDER BY id");
        let mut statement = old.prepare(&source_sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,i64>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?))).map_err(|error| error.to_string())?;
        for row in rows {
            let (legacy_id,source_key,source_type,account_key,account_label,label,chat_key,chat_type,checkpoint,status,last_sync) = row.map_err(|error| error.to_string())?;
            let name = if label.is_empty(){"旧 Telegram 来源".to_string()}else{label};
            let bound_tools = recovered_legacy_bindings(&name);
            let source_id = save_source(path, SourceInput {
                id: None,
                kind: legacy_source_kind(&source_type),
                external_id: if chat_key.is_empty(){source_key.clone()}else{chat_key},
                name,
                source_type: chat_type,
                enabled: status != "disabled",
                checkpoint: checkpoint.to_string(),
                continuation: String::new(),
                metadata: serde_json::json!({"legacySourceKey":source_key,"lastSyncAt":last_sync,"migratedFrom":"v0.4.5","accountKey":account_key,"account":account_label,"historyLimit":2000,"markRead":true,"legacyBindingsRecovered":!bound_tools.is_empty()}),
                bound_tools,
            })?;
            legacy_source_ids.insert(legacy_id, source_id);
            telegram_sources += 1;
        }
    }
    if table_exists(&old, "telegram_message_refs") && !legacy_source_ids.is_empty() {
        let mut statement = old.prepare("SELECT source_id,COALESCE(message_id,''),COALESCE(message_date,''),COALESCE(content_hash,'') FROM telegram_message_refs ORDER BY id").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).map_err(|error| error.to_string())?;
        let connection = open(path)?;
        let mut insert = connection.prepare("INSERT OR IGNORE INTO telegram_message_fingerprints(source_id,message_id,message_date,content_hash,created_at) VALUES (?1,?2,?3,?4,?5)").map_err(|error| error.to_string())?;
        let timestamp = now();
        for row in rows {
            let (legacy_source_id,message_id_raw,message_date,content_hash) = row.map_err(|error| error.to_string())?;
            let Some(source_id) = legacy_source_ids.get(&legacy_source_id) else { continue; };
            let Ok(message_id) = message_id_raw.parse::<i64>() else { continue; };
            telegram_fingerprints += insert.execute(params![source_id,message_id,message_date,content_hash,timestamp]).map_err(|error| error.to_string())?;
        }
    }

    let mut history_runs = 0_usize;
    if table_exists(&old, "tool_history_runs") && table_exists(&old, "tool_history_items") {
        let mut statement = old.prepare("SELECT id,tool_kind,name,COALESCE(source_label,''),COALESCE(time_start,''),COALESCE(time_end,''),COALESCE(metadata_json,'{}') FROM tool_history_runs ORDER BY id").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
        for (id,tool,name,source_label,start_at,end_at,metadata_raw) in rows {
            if !["twitter","badnews","haijiao","missav","av123"].contains(&tool.as_str()) { continue; }
            let mut item_statement = old.prepare("SELECT position,primary_text,COALESCE(secondary_text,''),COALESCE(metadata_json,'{}') FROM tool_history_items WHERE history_id=?1 ORDER BY position").map_err(|error| error.to_string())?;
            let item_rows = item_statement.query_map(params![id], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).map_err(|error| error.to_string())?;
            let results = item_rows.map(|row| { let (_position,primary,secondary,metadata) = row.map_err(|error| error.to_string())?; Ok(ResultInput { result_key: primary.to_ascii_lowercase().replace(' ', "").replace('-', ""), primary_value: primary, secondary_value: secondary, status: "migrated".to_string(), tags: Vec::new(), error: String::new(), source: source_label.clone(), metadata: serde_json::from_str(&metadata).unwrap_or_default() }) }).collect::<Result<Vec<_>,String>>()?;
            create_run(path, CreateRunInput { tool, name, input_kind: "v045_history".to_string(), original_input: String::new(), start_at, end_at, options: serde_json::json!({"legacyHistoryId":id,"legacyMetadata":serde_json::from_str::<serde_json::Value>(&metadata_raw).unwrap_or_default()}), results })?;
            history_runs += 1;
        }
    }
    if table_exists(&old, "processing_runs") && table_exists(&old, "processing_run_items") {
        let mut statement = old.prepare("SELECT id,COALESCE(name,''),COALESCE(source_label,''),COALESCE(started_at,''),COALESCE(finished_at,'') FROM processing_runs ORDER BY id").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
        for (id,name,source_label,start_at,end_at) in rows {
            let mut item_statement = old.prepare("SELECT position,code,COALESCE(url,''),COALESCE(result_status,item_status,'migrated'),COALESCE(final_tags_json,'[]'),COALESCE(error,''),COALESCE(source_url,''),COALESCE(actresses_json,'[]'),COALESCE(genres_json,'[]') FROM processing_run_items WHERE run_id=?1 ORDER BY position").map_err(|error| error.to_string())?;
            let item_rows = item_statement.query_map(params![id], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?))).map_err(|error| error.to_string())?;
            let results = item_rows.map(|row| { let (_position,code,url,status,tags,error,source,actresses,genres) = row.map_err(|error| error.to_string())?; Ok(ResultInput { result_key: code.to_ascii_lowercase().replace('-',""), primary_value: code, secondary_value: url, status, tags: serde_json::from_str(&tags).unwrap_or_default(), error, source, metadata: serde_json::json!({"actresses":serde_json::from_str::<serde_json::Value>(&actresses).unwrap_or_default(),"genres":serde_json::from_str::<serde_json::Value>(&genres).unwrap_or_default(),"legacyRunId":id}) }) }).collect::<Result<Vec<_>,String>>()?;
            create_run(path, CreateRunInput { tool: "missav".to_string(), name: if name.is_empty(){format!("v0.4.5 MissAV 批次 {id}")}else{name}, input_kind: "v045_processing_run".to_string(), original_input: String::new(), start_at, end_at, options: serde_json::json!({"legacyRunId":id,"sourceLabel":source_label}), results })?;
            history_runs += 1;
        }
    }
    set_setting(path, "migration.v045.completed", &serde_json::json!({"source":source.display().to_string(),"at":now(),"archivedTables":table_names.len(),"archivedRows":archived_rows}))?;
    Ok(LegacyMigrationResult { source_path: source.display().to_string(), archived_tables: table_names.len(), archived_rows, missav_records, av123_records, history_runs, telegram_sources, telegram_fingerprints, backup_path: backup.path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("v05.sqlite");
        let connection = Connection::open(&path).unwrap();
        initialize_schema(&connection).unwrap();
        (directory, path)
    }

    #[test]
    fn run_history_round_trip_and_crud() {
        let (_directory, path) = setup();
        let run_id = create_run(
            &path,
            CreateRunInput {
                tool: "haijiao".to_string(),
                name: "测试任务".to_string(),
                input_kind: "paste".to_string(),
                original_input: "原始内容".to_string(),
                start_at: String::new(),
                end_at: String::new(),
                options: serde_json::json!({"dedupe": true}),
                results: vec![ResultInput {
                    result_key: "127766".to_string(),
                    primary_value: "https://www.haijiaolove.xyz/hjsz/127766.html".to_string(),
                    secondary_value: String::new(),
                    status: "success".to_string(),
                    tags: vec!["海角".to_string()],
                    error: String::new(),
                    source: "paste".to_string(),
                    metadata: serde_json::json!({}),
                }],
            },
        )
        .unwrap();
        let detail = get_run(&path, run_id).unwrap();
        assert_eq!(detail.results.len(), 1);
        assert_eq!(detail.original_input, "原始内容");
        rename_run(&path, run_id, "已改名").unwrap();
        assert_eq!(list_runs(&path, Some("haijiao"), "已改名", 20).unwrap().len(), 1);
        update_result(
            &path,
            ResultUpdate {
                id: detail.results[0].id,
                field: "status".to_string(),
                value: serde_json::json!("review"),
            },
        )
        .unwrap();
        assert_eq!(get_run(&path, run_id).unwrap().results[0].status, "review");
    }

    #[test]
    fn sources_bind_multiple_tools_and_can_be_removed() {
        let (_directory, path) = setup();
        let id = save_source(
            &path,
            SourceInput {
                id: None,
                kind: "telegram_bot".to_string(),
                external_id: "-1001".to_string(),
                name: "测试群".to_string(),
                source_type: "supergroup".to_string(),
                enabled: true,
                checkpoint: String::new(),
                continuation: String::new(),
                metadata: serde_json::json!({}),
                bound_tools: vec!["twitter".to_string(), "haijiao".to_string()],
            },
        )
        .unwrap();
        let sources = list_sources(&path).unwrap();
        assert_eq!(sources[0].bound_tools.len(), 2);
        delete_source(&path, id).unwrap();
        assert!(list_sources(&path).unwrap().is_empty());
    }

    #[test]
    fn tool_binding_updates_are_atomic_and_preserve_other_tools() {
        let (_directory, path) = setup();
        let first = save_source(&path, SourceInput { id: None, kind: "telegram_user".to_string(), external_id: "group:binding-1".to_string(), name: "群组一".to_string(), source_type: "group".to_string(), enabled: true, checkpoint: String::new(), continuation: String::new(), metadata: serde_json::json!({}), bound_tools: vec!["twitter".to_string(), "missav".to_string()] }).unwrap();
        let second = save_source(&path, SourceInput { id: None, kind: "telegram_bot".to_string(), external_id: "group:binding-2".to_string(), name: "群组二".to_string(), source_type: "supergroup".to_string(), enabled: true, checkpoint: String::new(), continuation: String::new(), metadata: serde_json::json!({}), bound_tools: vec!["badnews".to_string()] }).unwrap();

        update_tool_source_bindings(&path, "missav", vec![
            ToolSourceBindingUpdate { source_id: first, bound: false },
            ToolSourceBindingUpdate { source_id: second, bound: true },
        ]).unwrap();
        let sources = list_sources(&path).unwrap();
        let first_source = sources.iter().find(|source| source.id == first).unwrap();
        let second_source = sources.iter().find(|source| source.id == second).unwrap();
        assert_eq!(first_source.bound_tools, vec!["twitter"]);
        assert_eq!(second_source.bound_tools, vec!["badnews", "missav"]);

        let failed = update_tool_source_bindings(&path, "missav", vec![
            ToolSourceBindingUpdate { source_id: first, bound: true },
            ToolSourceBindingUpdate { source_id: 999_999, bound: true },
        ]);
        assert!(failed.is_err());
        assert_eq!(list_sources(&path).unwrap().iter().find(|source| source.id == first).unwrap().bound_tools, vec!["twitter"]);
    }

    fn sample_run(tool: &str, key: &str) -> CreateRunInput {
        CreateRunInput { tool: tool.to_string(), name: format!("{tool} 同步任务"), input_kind: "telegram_user".to_string(), original_input: String::new(), start_at: String::new(), end_at: String::new(), options: serde_json::json!({"messageCount": 1}), results: vec![ResultInput { result_key: key.to_string(), primary_value: key.to_uppercase(), secondary_value: String::new(), status: "success".to_string(), tags: Vec::new(), error: String::new(), source: "测试群".to_string(), metadata: serde_json::json!({}) }] }
    }

    #[test]
    fn telegram_sync_commits_runs_fingerprints_checkpoint_and_inbox_atomically() {
        let (_directory, path) = setup();
        let source_id = save_source(&path, SourceInput { id: None, kind: "telegram_user".to_string(), external_id: "channel:1".to_string(), name: "测试频道".to_string(), source_type: "channel".to_string(), enabled: true, checkpoint: String::new(), continuation: String::new(), metadata: serde_json::json!({"markRead":true}), bound_tools: vec!["twitter".to_string(), "missav".to_string()] }).unwrap();
        let result = commit_telegram_sync(&path, TelegramCommitInput { source_id, checkpoint: "102".to_string(), continuation: String::new(), fingerprints: vec![TelegramFingerprintInput { message_id: 101, message_date: "2026-01-01T00:00:00Z".to_string(), content_hash: "a".to_string() }, TelegramFingerprintInput { message_id: 102, message_date: "2026-01-01T00:01:00Z".to_string(), content_hash: "b".to_string() }], runs: vec![sample_run("twitter", "alice"), sample_run("missav", "abp001")], safe_read_message_id: 102, read_state: "pending".to_string() }).unwrap();
        assert_eq!(result.run_ids.len(), 2);
        assert_eq!(result.saved_messages, 2);
        assert_eq!(known_telegram_message_ids(&path, source_id, &[100,101,102]).unwrap(), vec![101,102]);
        let source = list_sources(&path).unwrap().remove(0);
        assert_eq!(source.checkpoint, "102");
        assert_eq!(source.metadata["safeReadMessageId"], serde_json::json!(102));
        assert_eq!(source.metadata["readState"], serde_json::json!("pending"));
        assert_eq!(list_inbox(&path, "", "", 20).unwrap().len(), 2);

        update_telegram_read_result(&path, source_id, 102, "").unwrap();
        let source = list_sources(&path).unwrap().remove(0);
        assert_eq!(source.metadata["lastMarkedReadMessageId"], serde_json::json!(102));
        assert_eq!(source.metadata["readState"], serde_json::json!("marked"));

        let failed = commit_telegram_sync(&path, TelegramCommitInput { source_id, checkpoint: "103".to_string(), continuation: String::new(), fingerprints: vec![TelegramFingerprintInput { message_id: 103, message_date: String::new(), content_hash: "c".to_string() }], runs: vec![sample_run("unknown", "bad")], safe_read_message_id: 103, read_state: "pending".to_string() });
        assert!(failed.is_err());
        assert!(known_telegram_message_ids(&path, source_id, &[103]).unwrap().is_empty());
        assert_eq!(list_sources(&path).unwrap()[0].checkpoint, "102");
    }

    #[test]
    fn telegram_history_creates_a_read_baseline_and_manual_failures_remain_retryable() {
        let (_directory, path) = setup();
        let source_id = save_source(&path, SourceInput { id: None, kind: "telegram_user".to_string(), external_id: "channel:history".to_string(), name: "历史频道".to_string(), source_type: "channel".to_string(), enabled: true, checkpoint: String::new(), continuation: String::new(), metadata: serde_json::json!({"initialMode":"recent","readPolicy":"manual"}), bound_tools: vec!["twitter".to_string()] }).unwrap();

        commit_telegram_sync(&path, TelegramCommitInput { source_id, checkpoint: "50".to_string(), continuation: String::new(), fingerprints: Vec::new(), runs: Vec::new(), safe_read_message_id: 0, read_state: "history_skipped".to_string() }).unwrap();
        let source = list_sources(&path).unwrap().remove(0);
        assert_eq!(source.metadata["readBaselineMessageId"], serde_json::json!(50));
        assert_eq!(source.metadata["readState"], serde_json::json!("history_skipped"));

        commit_telegram_sync(&path, TelegramCommitInput { source_id, checkpoint: "50".to_string(), continuation: String::new(), fingerprints: Vec::new(), runs: Vec::new(), safe_read_message_id: 50, read_state: "pending".to_string() }).unwrap();
        assert_eq!(list_sources(&path).unwrap().remove(0).metadata["readState"], serde_json::json!("baseline"));

        commit_telegram_sync(&path, TelegramCommitInput { source_id, checkpoint: "51".to_string(), continuation: String::new(), fingerprints: Vec::new(), runs: Vec::new(), safe_read_message_id: 51, read_state: "pending".to_string() }).unwrap();
        update_telegram_read_result(&path, source_id, 51, "模拟网络失败").unwrap();
        let source = list_sources(&path).unwrap().remove(0);
        assert_eq!(source.metadata["safeReadMessageId"], serde_json::json!(51));
        assert_eq!(source.metadata["readState"], serde_json::json!("error"));
        assert_eq!(source.metadata["lastMarkedReadMessageId"], serde_json::Value::Null);
    }

    #[test]
    fn telegram_message_cache_is_shared_but_each_tool_queue_is_independent() {
        let (_directory, path) = setup();
        let source_id = save_source(&path, SourceInput {
            id: None, kind: "telegram_user".to_string(), external_id: "channel:queue".to_string(), name: "多工具频道".to_string(),
            source_type: "channel".to_string(), enabled: true, checkpoint: "90".to_string(), continuation: String::new(),
            metadata: serde_json::json!({}), bound_tools: vec!["twitter".to_string(), "missav".to_string()],
        }).unwrap();
        let stored = store_telegram_tool_messages(&path, TelegramStoreInput {
            source_id, tool: "twitter".to_string(), messages: vec![
                TelegramToolMessageInput { message_id: 101, message_date: "2026-07-28T01:00:00Z".to_string(), text: "#alice ABP-001".to_string(), content_hash: "h1".to_string(), candidate_count: 1, candidate_preview: "alice".to_string() },
                TelegramToolMessageInput { message_id: 102, message_date: "2026-07-28T01:01:00Z".to_string(), text: "没有结果".to_string(), content_hash: "h2".to_string(), candidate_count: 0, candidate_preview: String::new() },
            ],
        }).unwrap();
        assert_eq!(stored.stored_messages, 2);
        assert_eq!(stored.queued_items, 4);

        let twitter = query_telegram_tool_messages(&path, TelegramQueueQuery { tool: "twitter".to_string(), source_ids: vec![source_id], status: "pending".to_string(), search: String::new(), start_at: String::new(), end_at: String::new(), candidate_only: false, page: 1, page_size: 20 }).unwrap();
        let missav = query_telegram_tool_messages(&path, TelegramQueueQuery { tool: "missav".to_string(), source_ids: vec![source_id], status: "pending".to_string(), search: String::new(), start_at: String::new(), end_at: String::new(), candidate_only: false, page: 1, page_size: 20 }).unwrap();
        assert_eq!(twitter.total, 2);
        assert!(twitter.data.iter().all(|row| row.candidate_count >= 0));
        assert!(missav.data.iter().all(|row| row.candidate_count == -1));

        store_telegram_tool_messages(&path, TelegramStoreInput {
            source_id, tool: "missav".to_string(), messages: vec![TelegramToolMessageInput {
                message_id: 101, message_date: "2026-07-28T01:00:00Z".to_string(), text: "#alice ABP-001".to_string(),
                content_hash: "h1".to_string(), candidate_count: 1, candidate_preview: "ABP-001".to_string(),
            }],
        }).unwrap();
        resolve_telegram_tool_messages(&path, TelegramQueueResolveInput { tool: "missav".to_string(), keys: vec![TelegramMessageKey { source_id, message_id: 101 }], status: "ignored".to_string() }).unwrap();

        let run_id = create_telegram_message_run(&path, TelegramMessageRunInput {
            tool: "twitter".to_string(), keys: vec![TelegramMessageKey { source_id, message_id: 101 }],
            run: sample_run("twitter", "alice"),
        }).unwrap();
        assert!(run_id > 0);
        let twitter_message = get_telegram_tool_messages(&path, "twitter", &[TelegramMessageKey { source_id, message_id: 101 }]).unwrap().remove(0);
        let missav_message = get_telegram_tool_messages(&path, "missav", &[TelegramMessageKey { source_id, message_id: 101 }]).unwrap().remove(0);
        assert_eq!(twitter_message.status, "processed");
        assert_eq!(missav_message.status, "ignored");
        assert_eq!(telegram_tool_cursor(&path, "twitter", source_id).unwrap().source_checkpoint, 90);
    }

    #[test]
    fn telegram_worktable_supports_time_filter_create_edit_and_tool_scoped_delete() {
        let (_directory, path) = setup();
        let source_id = save_source(&path, SourceInput {
            id: None, kind: "telegram_user".to_string(), external_id: "group:crud".to_string(), name: "CRUD 群".to_string(),
            source_type: "group".to_string(), enabled: true, checkpoint: String::new(), continuation: String::new(),
            metadata: serde_json::json!({}), bound_tools: vec!["badnews".to_string()],
        }).unwrap();
        let created = create_telegram_tool_message(&path, TelegramMessageCreateInput {
            tool: "badnews".to_string(), source_id, message_date: "2026-07-29T04:00:00Z".to_string(),
            text: "https://bad.news/t/123".to_string(), content_hash: "first".to_string(), candidate_count: 1,
            candidate_preview: "https://bad.news/t/123".to_string(),
        }).unwrap();
        assert!(created.message_id < 0);

        let in_range = query_telegram_tool_messages(&path, TelegramQueueQuery {
            tool: "badnews".to_string(), source_ids: vec![source_id], status: String::new(), search: String::new(),
            start_at: "2026-07-29T03:59:00Z".to_string(), end_at: "2026-07-29T04:01:00Z".to_string(),
            candidate_only: false, page: 1, page_size: 20,
        }).unwrap();
        assert_eq!(in_range.total, 1);
        let outside = query_telegram_tool_messages(&path, TelegramQueueQuery {
            tool: "badnews".to_string(), source_ids: vec![source_id], status: String::new(), search: String::new(),
            start_at: "2026-07-29T05:00:00Z".to_string(), end_at: String::new(), candidate_only: false, page: 1, page_size: 20,
        }).unwrap();
        assert_eq!(outside.total, 0);

        update_telegram_tool_message(&path, TelegramMessageUpdateInput {
            tool: "badnews".to_string(), source_id, message_id: created.message_id, field: "text".to_string(),
            value: "https://bad.news/t/456".to_string(), content_hash: "second".to_string(), candidate_count: 1,
            candidate_preview: "https://bad.news/t/456".to_string(),
        }).unwrap();
        let edited = get_telegram_tool_messages(&path, "badnews", &[TelegramMessageKey { source_id, message_id: created.message_id }]).unwrap().remove(0);
        assert_eq!(edited.text, "https://bad.news/t/456");
        assert_eq!(edited.status, "pending");

        let deleted = delete_telegram_tool_messages(&path, "badnews", &[TelegramMessageKey { source_id, message_id: created.message_id }]).unwrap();
        assert_eq!(deleted, 1);
        assert!(get_telegram_tool_messages(&path, "badnews", &[TelegramMessageKey { source_id, message_id: created.message_id }]).is_err());
    }

    #[test]
    fn telegram_empty_processing_and_load_sessions_remain_auditable() {
        let (_directory, path) = setup();
        let source_id = save_source(&path, SourceInput { id: None, kind: "telegram_user".to_string(), external_id: "group:empty".to_string(), name: "空结果群".to_string(), source_type: "group".to_string(), enabled: true, checkpoint: String::new(), continuation: String::new(), metadata: serde_json::json!({}), bound_tools: vec!["haijiao".to_string()] }).unwrap();
        store_telegram_tool_messages(&path, TelegramStoreInput { source_id, tool: "haijiao".to_string(), messages: vec![TelegramToolMessageInput { message_id: 7, message_date: String::new(), text: "普通文字".to_string(), content_hash: "x".to_string(), candidate_count: 0, candidate_preview: String::new() }] }).unwrap();
        let run_id = create_telegram_message_run(&path, TelegramMessageRunInput {
            tool: "haijiao".to_string(), keys: vec![TelegramMessageKey { source_id, message_id: 7 }],
            run: CreateRunInput { tool: "haijiao".to_string(), name: "无结果".to_string(), input_kind: "telegram_workbench".to_string(), original_input: "普通文字".to_string(), start_at: String::new(), end_at: String::new(), options: serde_json::json!({}), results: Vec::new() },
        }).unwrap();
        assert_eq!(run_id, 0);
        assert_eq!(get_telegram_tool_messages(&path, "haijiao", &[TelegramMessageKey { source_id, message_id: 7 }]).unwrap()[0].status, "processed_empty");
        let session_id = record_telegram_load_session(&path, TelegramLoadSessionInput { tool: "haijiao".to_string(), source_id, mode: "latest".to_string(), requested_count: 100, scanned_count: 7, loaded_count: 6, next_before_id: 1, next_after_id: 7, status: "completed".to_string(), error: String::new() }).unwrap();
        assert!(session_id > 0);
    }

    #[test]
    fn backup_is_integral_and_restorable() {
        let (_directory, path) = setup();
        set_setting(&path, "theme", &serde_json::json!("green")).unwrap();
        let backup = create_backup(&path, Some("test")).unwrap();
        set_setting(&path, "theme", &serde_json::json!("dark")).unwrap();
        restore_backup(&path, Path::new(&backup.path)).unwrap();
        assert_eq!(get_setting(&path, "theme").unwrap(), Some(serde_json::json!("green")));
    }

    #[test]
    fn relocates_database_without_overwriting_and_keeps_integrity() {
        let (directory, path) = setup();
        set_setting(&path, "marker", &serde_json::json!(42)).unwrap();
        let target_dir = directory.path().join("custom-data");
        let target = relocate_database(&path, &target_dir).unwrap();
        assert_eq!(get_setting(&target, "marker").unwrap(), Some(serde_json::json!(42)));
        assert!(relocate_database(&path, &target_dir).is_err());
    }

    #[test]
    fn telegram_bot_tokens_are_redacted_in_new_and_existing_logs() {
        let (_directory, path) = setup();
        let leaked = "error sending request for url (https://api.telegram.org/bot123456789:SECRET_VALUE/getUpdates)";
        append_log(&path, "ERROR", "telegram", leaked, &serde_json::json!({"error": leaked})).unwrap();

        let connection = open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO app_logs(level,category,message,details_json,created_at) VALUES ('ERROR','legacy',?1,?2,?3)",
                params![leaked, serde_json::json!({"error": leaked}).to_string(), now()],
            )
            .unwrap();

        let logs = list_logs(&path, 10, "", "").unwrap();
        assert_eq!(logs.len(), 2);
        for log in logs {
            let rendered = format!("{} {}", log.message, log.details);
            assert!(!rendered.contains("123456789:SECRET_VALUE"));
            assert!(rendered.contains("[REDACTED]"));
        }
    }

    #[test]
    fn legacy_migration_archives_every_table_and_maps_core_data() {
        let (directory, path) = setup();
        let source = directory.path().join("legacy-v045.sqlite");
        let old = Connection::open(&source).unwrap();
        old.execute_batch(
            "CREATE TABLE actress_tags(id INTEGER PRIMARY KEY, tag_name TEXT, created_at TEXT, updated_at TEXT);
             CREATE TABLE actress_code_map(actress_id INTEGER, code_id INTEGER);
             CREATE TABLE genre_tags(id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE code_genres(code_id INTEGER, genre_id INTEGER);
             CREATE TABLE codes(id INTEGER PRIMARY KEY, code TEXT, best_url TEXT, status TEXT, source_url TEXT, missav_error TEXT,
               av123_url TEXT, av123_status TEXT, av123_error TEXT, raindrop_tags TEXT, raindrop_remote_id TEXT,
               raindrop_collection_id INTEGER, created_at TEXT, updated_at TEXT);
             CREATE TABLE telegram_sources(id INTEGER PRIMARY KEY, source_key TEXT, source_type TEXT, source_label TEXT,
               chat_key TEXT, chat_type TEXT, checkpoint_message_id INTEGER, status TEXT, last_sync_at TEXT);
             CREATE TABLE telegram_message_refs(id INTEGER PRIMARY KEY, source_id INTEGER, message_id TEXT, message_date TEXT, content_hash TEXT);
             CREATE TABLE mystery(id INTEGER, payload TEXT);
             INSERT INTO actress_tags VALUES(1,'女优A','',''); INSERT INTO actress_code_map VALUES(1,1);
             INSERT INTO genre_tags VALUES(1,'剧情'); INSERT INTO code_genres VALUES(1,1);
             INSERT INTO codes VALUES(1,'ABP-001','https://missav.ai/cn/abp-001','ok','','','https://123av.com/cn/v/abp-001','succeeded','','远端Tag','99',8,'2026-01-01','2026-01-02');
             INSERT INTO codes VALUES(2,'SSIS-002','https://missav.ai/cn/ssis-002','ok','','','','pending','','','',-1,'2026-01-01','2026-01-02');
             INSERT INTO telegram_sources VALUES(1,'legacy-source','api_group','番号待提取','-1001','supergroup',42,'idle','2026-01-02');
             INSERT INTO telegram_message_refs VALUES(1,1,'41','2026-01-01','hash-41');
             INSERT INTO mystery VALUES(7,'必须保留');"
        ).unwrap();
        drop(old);
        let result = migrate_legacy(&path, &source, false).unwrap();
        assert_eq!(result.missav_records, 2);
        assert_eq!(result.av123_records, 2);
        assert_eq!(result.telegram_sources, 1);
        assert_eq!(result.telegram_fingerprints, 1);
        assert!(result.archived_tables >= 7);
        let current = Connection::open(&path).unwrap();
        let archived: String = current.query_row("SELECT payload FROM legacy_v045_mystery WHERE id=7", [], |row| row.get(0)).unwrap();
        assert_eq!(archived, "必须保留");
        let page = query_permanent(&path, "missav", 1, 20, "ABP").unwrap();
        assert_eq!(page.total, 1);
        assert!(page.data[0].tags.contains(&"女优A".to_string()));
        assert!(page.data[0].genre_tags.contains(&"剧情".to_string()));
        let sources = list_sources(&path).unwrap();
        assert_eq!(sources[0].kind, "telegram_user");
        assert_eq!(sources[0].bound_tools, vec!["missav"]);
        assert_eq!(known_telegram_message_ids(&path, sources[0].id, &[40, 41]).unwrap(), vec![41]);
        assert!(migrate_legacy(&path, &source, false).is_err());
    }
}

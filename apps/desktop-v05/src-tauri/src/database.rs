use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use crate::models::{
    MigrationMapping, MigrationReport, PrototypeRecord, RecordPage, TableCount, TaskItem,
    TaskSummary,
};

const RECORD_FIELDS: &[&str] = &["code", "source", "status", "tags", "notes"];

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn open_runtime(path: &Path) -> Result<Connection, String> {
    Connection::open(path).map_err(|error| format!("打开 v0.5 原型数据库失败：{error}"))
}

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrototypeRecord> {
    Ok(PrototypeRecord {
        id: row.get(0)?,
        code: row.get(1)?,
        source: row.get(2)?,
        status: row.get(3)?,
        tags: row.get(4)?,
        notes: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskSummary> {
    Ok(TaskSummary {
        id: row.get(0)?,
        kind: row.get(1)?,
        status: row.get(2)?,
        total: row.get(3)?,
        completed: row.get(4)?,
        failed: row.get(5)?,
        message: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub fn initialize(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 v0.5 数据目录失败：{error}"))?;
    }
    let connection = open_runtime(path)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             PRAGMA synchronous=FULL;

             CREATE TABLE IF NOT EXISTS prototype_records (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               code TEXT NOT NULL UNIQUE,
               source TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT '待处理',
               tags TEXT NOT NULL DEFAULT '',
               notes TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );

             CREATE VIRTUAL TABLE IF NOT EXISTS prototype_records_fts USING fts5(
               code, source, tags, notes,
               content='prototype_records', content_rowid='id'
             );

             CREATE TRIGGER IF NOT EXISTS prototype_records_ai AFTER INSERT ON prototype_records BEGIN
               INSERT INTO prototype_records_fts(rowid, code, source, tags, notes)
               VALUES (new.id, new.code, new.source, new.tags, new.notes);
             END;
             CREATE TRIGGER IF NOT EXISTS prototype_records_ad AFTER DELETE ON prototype_records BEGIN
               INSERT INTO prototype_records_fts(prototype_records_fts, rowid, code, source, tags, notes)
               VALUES ('delete', old.id, old.code, old.source, old.tags, old.notes);
             END;
             CREATE TRIGGER IF NOT EXISTS prototype_records_au AFTER UPDATE ON prototype_records BEGIN
               INSERT INTO prototype_records_fts(prototype_records_fts, rowid, code, source, tags, notes)
               VALUES ('delete', old.id, old.code, old.source, old.tags, old.notes);
               INSERT INTO prototype_records_fts(rowid, code, source, tags, notes)
               VALUES (new.id, new.code, new.source, new.tags, new.notes);
             END;

             CREATE TABLE IF NOT EXISTS prototype_tasks (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('pending','running','paused','completed','cancelled')),
               total INTEGER NOT NULL DEFAULT 0,
               completed INTEGER NOT NULL DEFAULT 0,
               failed INTEGER NOT NULL DEFAULT 0,
               message TEXT NOT NULL DEFAULT '',
               item_delay_ms INTEGER NOT NULL DEFAULT 30,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS prototype_task_items (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               task_id INTEGER NOT NULL REFERENCES prototype_tasks(id) ON DELETE CASCADE,
               value TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('waiting','running','completed','failed','cancelled')),
               error TEXT NOT NULL DEFAULT '',
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_prototype_task_items_queue
               ON prototype_task_items(task_id, status, id);",
        )
        .map_err(|error| format!("初始化 v0.5 原型数据库失败：{error}"))?;
    Ok(())
}

pub fn recover_interrupted_tasks(path: &Path) -> Result<usize, String> {
    let mut connection = open_runtime(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let changed_items = transaction
        .execute(
            "UPDATE prototype_task_items
             SET status='waiting', updated_at=?1
             WHERE status='running'",
            params![now()],
        )
        .map_err(|error| error.to_string())?;
    let changed_tasks = transaction
        .execute(
            "UPDATE prototype_tasks
             SET status='paused', message='应用上次退出时任务仍在运行，已安全暂停，可继续执行。', updated_at=?1
             WHERE status='running'",
            params![now()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed_items + changed_tasks)
}

pub fn seed_records(path: &Path, count: u32) -> Result<i64, String> {
    let count = count.clamp(1, 100_000);
    let mut connection = open_runtime(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    {
        let mut statement = transaction
            .prepare_cached(
                "INSERT OR IGNORE INTO prototype_records
                 (code, source, status, tags, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            )
            .map_err(|error| error.to_string())?;
        for index in 1..=count {
            let prefix = match index % 5 {
                0 => "HAIJIAO",
                1 => "TWITTER",
                2 => "BADNEWS",
                3 => "MISSAV",
                _ => "TG",
            };
            let code = format!("{prefix}-{index:06}");
            let status = match index % 4 {
                0 => "已完成",
                1 => "待处理",
                2 => "需复查",
                _ => "已跳过",
            };
            let tags = format!("样例,批次{}", index % 37);
            let notes = format!("虚拟滚动性能样本第 {index} 行");
            statement
                .execute(params![code, prefix, status, tags, notes, timestamp])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    record_count(path)
}

pub fn record_count(path: &Path) -> Result<i64, String> {
    let connection = open_runtime(path)?;
    connection
        .query_row("SELECT COUNT(*) FROM prototype_records", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
}

fn make_fts_query(search: &str) -> String {
    search
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub fn query_records(
    path: &Path,
    page: u32,
    page_size: u32,
    search: &str,
) -> Result<RecordPage, String> {
    let page = page.max(1);
    let page_size = page_size.clamp(20, 500);
    let offset = i64::from((page - 1) * page_size);
    let limit = i64::from(page_size);
    let connection = open_runtime(path)?;
    let trimmed = search.trim();

    let (total, data) = if trimmed.is_empty() {
        let total = connection
            .query_row("SELECT COUNT(*) FROM prototype_records", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id, code, source, status, tags, notes, created_at, updated_at
                 FROM prototype_records ORDER BY id DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![limit, offset], map_record)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        (total, rows)
    } else {
        let fts_query = make_fts_query(trimmed);
        let total = connection
            .query_row(
                "SELECT COUNT(*) FROM prototype_records_fts WHERE prototype_records_fts MATCH ?1",
                params![fts_query],
                |row| row.get(0),
            )
            .map_err(|error| format!("搜索表达式无效：{error}"))?;
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.code, p.source, p.status, p.tags, p.notes, p.created_at, p.updated_at
                 FROM prototype_records p
                 JOIN prototype_records_fts f ON f.rowid = p.id
                 WHERE prototype_records_fts MATCH ?1
                 ORDER BY p.id DESC LIMIT ?2 OFFSET ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![fts_query, limit, offset], map_record)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        (total, rows)
    };

    let last_page = if total == 0 {
        1
    } else {
        ((total as u32) + page_size - 1) / page_size
    };
    Ok(RecordPage {
        data,
        page,
        page_size,
        last_page,
        total,
    })
}

pub fn update_record(path: &Path, id: i64, field: &str, value: &str) -> Result<(), String> {
    if !RECORD_FIELDS.contains(&field) {
        return Err(format!("字段 {field} 不允许编辑"));
    }
    if field == "code" && value.trim().is_empty() {
        return Err("编号不能为空".to_string());
    }
    let connection = open_runtime(path)?;
    let sql = format!("UPDATE prototype_records SET {field}=?1, updated_at=?2 WHERE id=?3");
    let changed = connection
        .execute(&sql, params![value.trim(), now(), id])
        .map_err(|error| format!("保存单元格失败：{error}"))?;
    if changed == 0 {
        return Err("记录不存在或已被删除".to_string());
    }
    Ok(())
}

pub fn create_demo_task(path: &Path, total: u32, item_delay_ms: u64) -> Result<i64, String> {
    let total = total.clamp(1, 20_000);
    let item_delay_ms = item_delay_ms.clamp(1, 5_000) as i64;
    let mut connection = open_runtime(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    transaction
        .execute(
            "INSERT INTO prototype_tasks
             (kind, status, total, completed, failed, message, item_delay_ms, created_at, updated_at)
             VALUES ('可靠任务原型', 'pending', ?1, 0, 0, '等待开始', ?2, ?3, ?3)",
            params![total, item_delay_ms, timestamp],
        )
        .map_err(|error| error.to_string())?;
    let task_id = transaction.last_insert_rowid();
    {
        let mut statement = transaction
            .prepare_cached(
                "INSERT INTO prototype_task_items (task_id, value, status, error, updated_at)
                 VALUES (?1, ?2, 'waiting', '', ?3)",
            )
            .map_err(|error| error.to_string())?;
        for index in 1..=total {
            statement
                .execute(params![task_id, format!("ITEM-{index:06}"), timestamp])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(task_id)
}

pub fn list_tasks(path: &Path) -> Result<Vec<TaskSummary>, String> {
    let connection = open_runtime(path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kind, status, total, completed, failed, message, created_at, updated_at
             FROM prototype_tasks ORDER BY id DESC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let tasks = statement
        .query_map([], map_task)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(tasks)
}

pub fn get_task(path: &Path, task_id: i64) -> Result<TaskSummary, String> {
    let connection = open_runtime(path)?;
    connection
        .query_row(
            "SELECT id, kind, status, total, completed, failed, message, created_at, updated_at
             FROM prototype_tasks WHERE id=?1",
            params![task_id],
            map_task,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "任务不存在".to_string())
}

pub fn task_delay_ms(path: &Path, task_id: i64) -> Result<u64, String> {
    let connection = open_runtime(path)?;
    let delay: i64 = connection
        .query_row(
            "SELECT item_delay_ms FROM prototype_tasks WHERE id=?1",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(delay.max(1) as u64)
}

pub fn set_task_status(path: &Path, task_id: i64, status: &str) -> Result<(), String> {
    if !["running", "paused", "cancelled"].contains(&status) {
        return Err("不允许的任务状态".to_string());
    }
    let connection = open_runtime(path)?;
    let message = match status {
        "running" => "正在执行",
        "paused" => "已由用户暂停，可继续执行",
        "cancelled" => "已取消，未执行项目保留为取消状态",
        _ => "",
    };
    let changed = connection
        .execute(
            "UPDATE prototype_tasks SET status=?1, message=?2, updated_at=?3
             WHERE id=?4 AND status NOT IN ('completed','cancelled')",
            params![status, message, now(), task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("任务已结束或不存在".to_string());
    }
    if status == "cancelled" {
        connection
            .execute(
                "UPDATE prototype_task_items SET status='cancelled', updated_at=?1
                 WHERE task_id=?2 AND status IN ('waiting','running')",
                params![now(), task_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn take_next_item(path: &Path, task_id: i64) -> Result<Option<TaskItem>, String> {
    let mut connection = open_runtime(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let task_status: Option<String> = transaction
        .query_row(
            "SELECT status FROM prototype_tasks WHERE id=?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if task_status.as_deref() != Some("running") {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let item = transaction
        .query_row(
            "SELECT id, value FROM prototype_task_items
             WHERE task_id=?1 AND status='waiting' ORDER BY id LIMIT 1",
            params![task_id],
            |row| {
                Ok(TaskItem {
                    id: row.get(0)?,
                    value: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(ref item) = item {
        transaction
            .execute(
                "UPDATE prototype_task_items SET status='running', updated_at=?1 WHERE id=?2",
                params![now(), item.id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(item)
}

pub fn complete_task_item(path: &Path, task_id: i64, item_id: i64) -> Result<(), String> {
    let mut connection = open_runtime(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE prototype_task_items SET status='completed', updated_at=?1
             WHERE id=?2 AND task_id=?3 AND status='running'",
            params![now(), item_id, task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed > 0 {
        transaction
            .execute(
                "UPDATE prototype_tasks SET completed=completed+1, updated_at=?1 WHERE id=?2",
                params![now(), task_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn finish_task_if_empty(path: &Path, task_id: i64) -> Result<bool, String> {
    let connection = open_runtime(path)?;
    let waiting: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM prototype_task_items
             WHERE task_id=?1 AND status IN ('waiting','running')",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if waiting == 0 {
        connection
            .execute(
                "UPDATE prototype_tasks SET status='completed', message='全部项目处理完成', updated_at=?1
                 WHERE id=?2 AND status='running'",
                params![now(), task_id],
            )
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

fn table_names(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(names)
}

fn mapping_for(name: &str, rows: i64) -> MigrationMapping {
    let lower = name.to_ascii_lowercase();
    let (target_area, note) = if ["codes", "records", "items", "av_records"]
        .iter()
        .any(|candidate| lower.contains(candidate))
    {
        ("统一内容记录", "候选：番号、状态与来源")
    } else if lower.contains("tag") {
        ("统一标签", "候选：标签及标签关系")
    } else if lower.contains("run") || lower.contains("batch") || lower.contains("history") {
        ("任务与历史", "候选：旧批次、处理历史和运行结果")
    } else if lower.contains("telegram") || lower.contains("source") || lower.contains("chat") {
        ("Telegram 来源", "候选：账号、群组、频道和增量游标")
    } else if lower.contains("raindrop") || lower.contains("remote") || lower.contains("bookmark") {
        ("远端同步映射", "候选：Raindrop 收藏和同步状态")
    } else if lower.contains("cache") {
        ("可丢弃缓存", "默认不迁移，可在新版本重建")
    } else {
        ("待人工确认", "未识别表，不会自动迁移")
    };
    MigrationMapping {
        source_table: name.to_string(),
        target_area: target_area.to_string(),
        recognized: target_area != "待人工确认",
        rows,
        note: note.to_string(),
    }
}

pub fn analyze_legacy_database(path: &Path) -> Result<MigrationReport, String> {
    if !path.is_file() {
        return Err("请选择一个存在的 SQLite 数据库文件副本".to_string());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("只读打开旧数据库失败：{error}"))?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;")
        .map_err(|error| format!("启用只读保护失败：{error}"))?;

    let integrity_check: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("完整性检查失败：{error}"))?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut tables = Vec::new();
    let mut mappings = Vec::new();
    let mut total_rows = 0;
    for name in table_names(&connection)? {
        let escaped = name.replace('"', "\"\"");
        let count_sql = format!("SELECT COUNT(*) FROM \"{escaped}\"");
        let rows = connection
            .query_row(&count_sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0);
        total_rows += rows;
        tables.push(TableCount {
            name: name.clone(),
            rows,
        });
        mappings.push(mapping_for(&name, rows));
    }

    let mut warnings = vec![
        "本页只生成迁移报告，不会修改旧库，也不会写入 v0.5 库。".to_string(),
        "正式迁移前仍会自动备份，并要求人工确认报告。".to_string(),
    ];
    if integrity_check.to_ascii_lowercase() != "ok" {
        warnings.push("旧库完整性检查未通过，禁止直接迁移。".to_string());
    }
    if mappings.iter().any(|mapping| !mapping.recognized) {
        warnings.push("存在未识别表，正式迁移时必须逐表决定。".to_string());
    }

    Ok(MigrationReport {
        source_path: path.display().to_string(),
        integrity_check,
        user_version,
        journal_mode,
        total_rows,
        tables,
        mappings,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::tempdir;

    #[test]
    fn seeds_queries_and_edits_records() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("prototype.sqlite");
        initialize(&path).unwrap();
        assert_eq!(seed_records(&path, 1_000).unwrap(), 1_000);
        let page = query_records(&path, 1, 100, "MISSAV").unwrap();
        assert_eq!(page.data.len(), 100);
        assert_eq!(page.total, 200);
        let first = page.data.first().unwrap();
        update_record(&path, first.id, "notes", "已编辑").unwrap();
        let found = query_records(&path, 1, 20, "已编辑").unwrap();
        assert_eq!(found.total, 1);
    }

    #[test]
    fn handles_one_hundred_thousand_records_with_server_paging() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("large-prototype.sqlite");
        initialize(&path).unwrap();
        let started = Instant::now();
        assert_eq!(seed_records(&path, 100_000).unwrap(), 100_000);
        let page = query_records(&path, 250, 200, "").unwrap();
        assert_eq!(page.data.len(), 200);
        assert_eq!(page.total, 100_000);
        let search = query_records(&path, 1, 200, "HAIJIAO").unwrap();
        assert_eq!(search.total, 20_000);
        eprintln!(
            "100k seed and representative queries: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn recovers_interrupted_task_without_losing_items() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("prototype.sqlite");
        initialize(&path).unwrap();
        let task_id = create_demo_task(&path, 10, 1).unwrap();
        set_task_status(&path, task_id, "running").unwrap();
        let item = take_next_item(&path, task_id).unwrap().unwrap();
        assert!(item.value.starts_with("ITEM-"));
        recover_interrupted_tasks(&path).unwrap();
        let task = get_task(&path, task_id).unwrap();
        assert_eq!(task.status, "paused");
        set_task_status(&path, task_id, "running").unwrap();
        let recovered = take_next_item(&path, task_id).unwrap().unwrap();
        assert_eq!(recovered.id, item.id);
    }

    #[test]
    fn analyzes_legacy_database_read_only() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE codes(id INTEGER PRIMARY KEY, code TEXT);
                     CREATE TABLE mystery(id INTEGER PRIMARY KEY);
                     INSERT INTO codes(code) VALUES ('ABP-001');",
                )
                .unwrap();
        }
        let before = fs::metadata(&path).unwrap().len();
        let report = analyze_legacy_database(&path).unwrap();
        let after = fs::metadata(&path).unwrap().len();
        assert_eq!(before, after);
        assert_eq!(report.integrity_check, "ok");
        assert_eq!(report.total_rows, 1);
        assert!(report.mappings.iter().any(|mapping| mapping.recognized));
        assert!(report.mappings.iter().any(|mapping| !mapping.recognized));
    }
}

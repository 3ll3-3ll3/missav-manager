use std::fs;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::models::{MigrationMapping, MigrationReport, TableCount};

/// Opens only the formal v0.5 schema. Early prototype tables are deliberately
/// not created in new databases.
pub fn initialize(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建数据目录失败：{error}"))?;
    }
    let connection = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;")
        .map_err(|error| error.to_string())?;
    crate::workspace::initialize_schema(&connection)
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

/// Read-only report; it never opens a legacy database for writing.
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
        let rows = connection
            .query_row(&format!("SELECT COUNT(*) FROM \"{escaped}\""), [], |row| row.get::<_, i64>(0))
            .unwrap_or(0);
        total_rows += rows;
        tables.push(TableCount { name: name.clone(), rows });
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

    Ok(MigrationReport { source_path: path.display().to_string(), integrity_check, user_version, journal_mode, total_rows, tables, mappings, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn analyzes_legacy_database_read_only() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE codes(id INTEGER PRIMARY KEY, code TEXT); CREATE TABLE mystery(id INTEGER PRIMARY KEY); INSERT INTO codes(code) VALUES ('ABP-001');").unwrap();
        let before = fs::metadata(&path).unwrap().len();
        let report = analyze_legacy_database(&path).unwrap();
        assert_eq!(before, fs::metadata(&path).unwrap().len());
        assert_eq!(report.integrity_check, "ok");
        assert_eq!(report.total_rows, 1);
        assert!(report.mappings.iter().any(|mapping| mapping.recognized));
        assert!(report.mappings.iter().any(|mapping| !mapping.recognized));
    }
}

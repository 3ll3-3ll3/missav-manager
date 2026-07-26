use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub name: String,
    pub rows: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationMapping {
    pub source_table: String,
    pub target_area: String,
    pub recognized: bool,
    pub rows: i64,
    pub note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub source_path: String,
    pub integrity_check: String,
    pub user_version: i64,
    pub journal_mode: String,
    pub total_rows: i64,
    pub tables: Vec<TableCount>,
    pub mappings: Vec<MigrationMapping>,
    pub warnings: Vec<String>,
}

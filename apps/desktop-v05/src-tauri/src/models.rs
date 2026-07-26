use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrototypeRecord {
    pub id: i64,
    pub code: String,
    pub source: String,
    pub status: String,
    pub tags: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPage {
    pub data: Vec<PrototypeRecord>,
    pub page: u32,
    pub page_size: u32,
    pub last_page: u32,
    pub total: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordUpdate {
    pub id: i64,
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: i64,
    pub kind: String,
    pub status: String,
    pub total: i64,
    pub completed: i64,
    pub failed: i64,
    pub message: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub task: TaskSummary,
    pub current_item: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskItem {
    pub id: i64,
    pub value: String,
}

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

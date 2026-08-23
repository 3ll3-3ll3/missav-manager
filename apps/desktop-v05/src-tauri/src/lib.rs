mod database;
mod chrome_bridge;
mod cloud_sync;
mod missav_blacklists;
mod models;
mod network;
mod telegram_user;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use models::MigrationReport;
use workspace::{BackupInfo, CreateRunInput, LegacyMigrationResult, LogEntry, PermanentPage, RunDetail, RunSummary, SourceInput, SourceRecord};

#[derive(Clone)]
struct RuntimeState {
    database_path: Arc<PathBuf>,
}

struct AppState {
    runtime: RuntimeState,
    chrome_bridge: Option<chrome_bridge::ChromeBridge>,
    chrome_bridge_error: String,
    extension_path: PathBuf,
    database_location_config: PathBuf,
    missav_blacklist_directory: PathBuf,
    telegram_user: Arc<telegram_user::TelegramUserRuntime>,
    cloud_sync: Arc<cloud_sync::CloudSyncRuntime>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    database_path: String,
    record_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadInputFile {
    path: String,
    name: String,
    bytes: u64,
    text: String,
    error: String,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        database_path: state.runtime.database_path.display().to_string(),
        record_count: workspace::permanent_count(state.runtime.database_path.as_ref())?,
    })
}

#[tauri::command]
fn analyze_legacy_database(path: String) -> Result<MigrationReport, String> {
    database::analyze_legacy_database(PathBuf::from(path).as_path())
}

#[tauri::command]
fn create_content_run(state: State<'_, AppState>, input: CreateRunInput) -> Result<i64, String> {
    workspace::create_run(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn list_content_runs(
    state: State<'_, AppState>,
    tool: Option<String>,
    search: String,
    limit: u32,
) -> Result<Vec<RunSummary>, String> {
    workspace::list_runs(
        state.runtime.database_path.as_ref(),
        tool.as_deref(),
        &search,
        limit,
    )
}

#[tauri::command]
fn get_content_run(state: State<'_, AppState>, run_id: i64) -> Result<RunDetail, String> {
    workspace::get_run(state.runtime.database_path.as_ref(), run_id)
}

#[tauri::command]
fn rename_content_run(
    state: State<'_, AppState>,
    run_id: i64,
    name: String,
) -> Result<(), String> {
    workspace::rename_run(state.runtime.database_path.as_ref(), run_id, &name)
}

#[tauri::command]
fn delete_content_run(state: State<'_, AppState>, run_id: i64) -> Result<(), String> {
    workspace::delete_run(state.runtime.database_path.as_ref(), run_id)
}

#[tauri::command]
fn update_content_result(
    state: State<'_, AppState>,
    update: workspace::ResultUpdate,
) -> Result<(), String> {
    workspace::update_result(state.runtime.database_path.as_ref(), update)
}

#[tauri::command]
fn delete_content_results(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    workspace::delete_results(state.runtime.database_path.as_ref(), &ids)
}

#[tauri::command]
fn query_permanent_records(state: State<'_, AppState>, tool: String, page: u32, page_size: u32, search: String) -> Result<PermanentPage, String> {
    workspace::query_permanent(state.runtime.database_path.as_ref(), &tool, page, page_size, &search)
}

#[tauri::command]
fn query_permanent_record_ids(state: State<'_, AppState>, tool: String, search: String) -> Result<Vec<i64>, String> {
    workspace::query_permanent_ids(state.runtime.database_path.as_ref(), &tool, &search)
}

#[tauri::command]
fn update_permanent_record(state: State<'_, AppState>, update: workspace::PermanentUpdate) -> Result<(), String> {
    workspace::update_permanent(state.runtime.database_path.as_ref(), update)
}

#[tauri::command]
fn update_permanent_records(state: State<'_, AppState>, ids: Vec<i64>, field: String, value: serde_json::Value) -> Result<usize, String> {
    workspace::update_permanent_many(state.runtime.database_path.as_ref(), &ids, &field, &value)
}

#[tauri::command]
fn delete_permanent_records(state: State<'_, AppState>, ids: Vec<i64>) -> Result<usize, String> {
    workspace::delete_permanent(state.runtime.database_path.as_ref(), &ids)
}

#[tauri::command]
fn list_input_sources(state: State<'_, AppState>) -> Result<Vec<SourceRecord>, String> {
    workspace::list_sources(state.runtime.database_path.as_ref())
}

#[tauri::command]
fn save_input_source(state: State<'_, AppState>, input: SourceInput) -> Result<i64, String> {
    workspace::save_source(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn update_tool_source_bindings(
    state: State<'_, AppState>,
    tool: String,
    updates: Vec<workspace::ToolSourceBindingUpdate>,
) -> Result<usize, String> {
    workspace::update_tool_source_bindings(state.runtime.database_path.as_ref(), &tool, updates)
}

#[tauri::command]
fn delete_input_source(state: State<'_, AppState>, source_id: i64) -> Result<(), String> {
    workspace::delete_source(state.runtime.database_path.as_ref(), source_id)
}

#[tauri::command]
fn known_telegram_message_ids(state: State<'_, AppState>, source_id: i64, ids: Vec<i64>) -> Result<Vec<i64>, String> {
    workspace::known_telegram_message_ids(state.runtime.database_path.as_ref(), source_id, &ids)
}

#[tauri::command]
fn commit_telegram_sync(state: State<'_, AppState>, input: workspace::TelegramCommitInput) -> Result<workspace::TelegramCommitResult, String> {
    workspace::commit_telegram_sync(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn list_inbox_tasks(state: State<'_, AppState>, stage: String, search: String, limit: u32) -> Result<Vec<workspace::InboxTask>, String> {
    workspace::list_inbox(state.runtime.database_path.as_ref(), &stage, &search, limit)
}

#[tauri::command]
fn update_inbox_task_stage(state: State<'_, AppState>, id: i64, stage: String) -> Result<(), String> {
    workspace::update_inbox_stage(state.runtime.database_path.as_ref(), id, &stage)
}

#[tauri::command]
fn record_script_generation(state: State<'_, AppState>, run_id: Option<i64>, template_version: String, code_count: u32) -> Result<(), String> {
    workspace::record_script_generation(state.runtime.database_path.as_ref(), run_id, &template_version, code_count)
}

#[tauri::command]
fn get_app_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    workspace::get_setting(state.runtime.database_path.as_ref(), &key)
}

#[tauri::command]
fn set_app_setting(
    state: State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    workspace::set_setting(state.runtime.database_path.as_ref(), &key, &value)
}

#[tauri::command]
fn read_missav_blacklist_files(state: State<'_, AppState>) -> Result<missav_blacklists::BlacklistFilesSnapshot, String> {
    missav_blacklists::read_files(&state.missav_blacklist_directory)
}

#[tauri::command]
fn write_missav_blacklist_file(
    state: State<'_, AppState>,
    kind: String,
    content: String,
) -> Result<missav_blacklists::BlacklistFilesSnapshot, String> {
    let kind = missav_blacklists::BlacklistKind::parse(&kind)?;
    missav_blacklists::write_file(&state.missav_blacklist_directory, kind, &content)
}

#[tauri::command]
fn open_missav_blacklist_folder(state: State<'_, AppState>) -> Result<(), String> {
    missav_blacklists::ensure_files(&state.missav_blacklist_directory)?;
    std::process::Command::new("explorer.exe")
        .arg(&state.missav_blacklist_directory)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn append_app_log(
    state: State<'_, AppState>,
    level: String,
    category: String,
    message: String,
    details: serde_json::Value,
) -> Result<(), String> {
    workspace::append_log(
        state.runtime.database_path.as_ref(),
        &level,
        &category,
        &message,
        &details,
    )
}

#[tauri::command]
fn list_app_logs(
    state: State<'_, AppState>,
    limit: u32,
    level: String,
    search: String,
) -> Result<Vec<LogEntry>, String> {
    workspace::list_logs(
        state.runtime.database_path.as_ref(),
        limit,
        &level,
        &search,
    )
}

#[tauri::command]
fn create_database_backup(
    state: State<'_, AppState>,
    label: Option<String>,
) -> Result<BackupInfo, String> {
    workspace::create_backup(state.runtime.database_path.as_ref(), label.as_deref())
}

#[tauri::command]
fn list_database_backups(state: State<'_, AppState>) -> Result<Vec<BackupInfo>, String> {
    workspace::list_backups(state.runtime.database_path.as_ref())
}

#[tauri::command]
fn restore_database_backup(
    state: State<'_, AppState>,
    backup_path: String,
) -> Result<(), String> {
    workspace::restore_backup(
        state.runtime.database_path.as_ref(),
        PathBuf::from(backup_path).as_path(),
    )
}

#[tauri::command]
fn read_input_files(paths: Vec<String>) -> Result<Vec<ReadInputFile>, String> {
    if paths.len() > 200 {
        return Err("一次最多读取 200 个文件".to_string());
    }
    let allowed = ["txt", "html", "htm", "md", "json", "csv", "log", "js"];
    let mut total_bytes = 0_u64;
    let mut output = Vec::with_capacity(paths.len());
    for value in paths {
        let path = PathBuf::from(&value);
        let name = path
            .file_name()
            .and_then(|item| item.to_str())
            .unwrap_or_default()
            .to_string();
        let extension = path
            .extension()
            .and_then(|item| item.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !allowed.contains(&extension.as_str()) {
            output.push(ReadInputFile {
                path: value,
                name,
                bytes: 0,
                text: String::new(),
                error: "不支持的文件类型".to_string(),
            });
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.len() <= 80 * 1024 * 1024 => {
                total_bytes += metadata.len();
                if total_bytes > 300 * 1024 * 1024 {
                    return Err("本次文件总大小超过 300 MB".to_string());
                }
                match std::fs::read(&path) {
                    Ok(bytes) => {
                        let text = String::from_utf8(bytes.clone()).unwrap_or_else(|_| {
                            bytes.iter().map(|byte| *byte as char).collect::<String>()
                        });
                        output.push(ReadInputFile {
                            path: value,
                            name,
                            bytes: metadata.len(),
                            text,
                            error: String::new(),
                        });
                    }
                    Err(error) => output.push(ReadInputFile {
                        path: value,
                        name,
                        bytes: metadata.len(),
                        text: String::new(),
                        error: error.to_string(),
                    }),
                }
            }
            Ok(_) => output.push(ReadInputFile {
                path: value,
                name,
                bytes: 0,
                text: String::new(),
                error: "单文件超过 80 MB".to_string(),
            }),
            Err(error) => output.push(ReadInputFile {
                path: value,
                name,
                bytes: 0,
                text: String::new(),
                error: error.to_string(),
            }),
        }
    }
    Ok(output)
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(target, content.as_bytes()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn fetch_site_page(state: State<'_, AppState>, url: String, proxy: String, timeout_ms: u64) -> Result<network::HttpResponse, String> {
    let result = network::fetch_page(&url, &proxy, timeout_ms).await;
    match &result {
        Ok(response) => { let _ = workspace::append_log(state.runtime.database_path.as_ref(), "INFO", "network", "网站请求完成", &serde_json::json!({"url":url,"status":response.status_code,"durationMs":response.duration_ms,"bytes":response.response_bytes})); },
        Err(error) => { let _ = workspace::append_log(state.runtime.database_path.as_ref(), "ERROR", "network", "网站请求失败", &serde_json::json!({"url":url,"error":error})); },
    }
    result
}

#[tauri::command]
async fn call_telegram_bot(state: State<'_, AppState>, input: network::TelegramBotRequest) -> Result<network::HttpResponse, String> {
    let method = input.method.clone();
    let lease = if method.eq_ignore_ascii_case("getUpdates") {
        state.cloud_sync.acquire_telegram_lease(state.runtime.database_path.as_ref(), "bot", "global-offset").await?
    } else { None };
    let mut result = network::telegram_bot_request(input).await;
    if let Some(lease) = lease {
        if let Err(error) = lease.release().await {
            if result.is_ok() { result = Err(error); }
        }
    }
    match &result {
        Ok(response) => { let _ = workspace::append_log(state.runtime.database_path.as_ref(), "INFO", "telegram", "Telegram Bot 请求完成", &serde_json::json!({"method":method,"status":response.status_code,"durationMs":response.duration_ms})); },
        Err(error) => { let _ = workspace::append_log(state.runtime.database_path.as_ref(), "ERROR", "telegram", "Telegram Bot 请求失败", &serde_json::json!({"method":method,"error":error})); },
    }
    result
}

#[tauri::command]
async fn telegram_user_status(state: State<'_, AppState>) -> Result<telegram_user::AuthState, String> {
    Ok(state.telegram_user.status().await)
}

#[tauri::command]
async fn telegram_user_connect(state: State<'_, AppState>) -> Result<telegram_user::AuthState, String> {
    let result = state.telegram_user.begin_connect_saved();
    let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 个人账号恢复连接", &serde_json::json!({"ok":result.is_ok()}));
    result
}

#[tauri::command]
async fn telegram_user_start_phone(state: State<'_, AppState>, api_id: i32, api_hash: String, phone: String, proxy_url: String) -> Result<telegram_user::AuthState, String> {
    let result = state.telegram_user.begin_phone(api_id, api_hash, phone, proxy_url);
    let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 手机号登录步骤", &serde_json::json!({"ok":result.is_ok(),"error":result.as_ref().err().cloned().unwrap_or_default()}));
    result
}

#[tauri::command]
async fn telegram_user_submit_code(state: State<'_, AppState>, code: String) -> Result<telegram_user::AuthState, String> {
    state.telegram_user.submit_code(code).await
}

#[tauri::command]
async fn telegram_user_submit_password(state: State<'_, AppState>, password: String) -> Result<telegram_user::AuthState, String> {
    state.telegram_user.submit_password(password).await
}

#[tauri::command]
async fn telegram_user_qr_step(state: State<'_, AppState>, api_id: i32, api_hash: String, proxy_url: String) -> Result<telegram_user::AuthState, String> {
    let result = state.telegram_user.begin_qr(api_id, api_hash, proxy_url);
    let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 扫码登录启动", &serde_json::json!({"ok":result.is_ok(),"error":result.as_ref().err().cloned().unwrap_or_default()}));
    result
}

#[tauri::command]
async fn telegram_user_qr_poll(state: State<'_, AppState>, confirm: bool) -> Result<telegram_user::AuthState, String> {
    let result = state.telegram_user.poll_qr(confirm).await;
    if result.as_ref().map(|value| value.connected).unwrap_or(false) || result.is_err() {
        let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 扫码登录确认", &serde_json::json!({"ok":result.is_ok(),"connected":result.as_ref().map(|value|value.connected).unwrap_or(false),"error":result.as_ref().err().cloned().unwrap_or_default()}));
    }
    result
}

#[tauri::command]
async fn telegram_user_cancel_auth(state: State<'_, AppState>) -> Result<telegram_user::AuthState, String> {
    Ok(state.telegram_user.cancel_auth())
}

#[tauri::command]
async fn telegram_user_list_dialogs(state: State<'_, AppState>, limit: usize) -> Result<Vec<telegram_user::TelegramDialog>, String> {
    let result = state.telegram_user.list_dialogs(limit).await;
    let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 群组与频道列表刷新", &serde_json::json!({"count":result.as_ref().map(|rows|rows.len()).unwrap_or(0),"ok":result.is_ok()}));
    result
}

#[tauri::command]
async fn telegram_user_sync_messages(state: State<'_, AppState>, input: telegram_user::TelegramSyncRequest) -> Result<telegram_user::TelegramSyncResult, String> {
    let source_id = input.external_id.clone();
    let lease = state.cloud_sync.acquire_telegram_lease(state.runtime.database_path.as_ref(), "personal", &source_id).await?;
    let mut result = state.telegram_user.sync_messages(input).await;
    if let Some(lease) = lease {
        if let Err(error) = lease.release().await {
            if result.is_ok() { result = Err(error); }
        }
    }
    let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 个人账号增量同步", &serde_json::json!({"sourceId":source_id,"count":result.as_ref().map(|row|row.messages.len()).unwrap_or(0),"ok":result.is_ok()}));
    result
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelegramToolHistoryInput {
    source_id: i64,
    tool: String,
    limit: usize,
    #[serde(default)]
    start: String,
    #[serde(default)]
    end: String,
    #[serde(default)]
    before_id: i32,
    #[serde(default)]
    after_id: i32,
}

#[tauri::command]
async fn telegram_user_load_history(state: State<'_, AppState>, input: TelegramToolHistoryInput) -> Result<telegram_user::TelegramHistoryResult, String> {
    let (external_id, source_name) = workspace::telegram_user_source_for_tool(
        state.runtime.database_path.as_ref(), input.source_id, &input.tool,
    )?;
    let source_id = input.source_id;
    let tool = input.tool.clone();
    let request = telegram_user::TelegramHistoryRequest {
        external_id: external_id.clone(), limit: input.limit, start: input.start, end: input.end,
        before_id: input.before_id, after_id: input.after_id,
    };
    let lease = state.cloud_sync.acquire_telegram_lease(state.runtime.database_path.as_ref(), "personal", &external_id).await?;
    let mut result = state.telegram_user.load_history(request).await;
    if let Some(lease) = lease {
        if let Err(error) = lease.release().await {
            if result.is_ok() { result = Err(error); }
        }
    }
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if result.is_ok() { "INFO" } else { "ERROR" },
        "telegram_user",
        "Telegram 工具工作页加载历史",
        &serde_json::json!({
            "sourceId":source_id,"sourceName":source_name,"tool":tool,
            "count":result.as_ref().map(|row|row.messages.len()).unwrap_or(0),
            "scanned":result.as_ref().map(|row|row.scanned_count).unwrap_or(0),
            "ok":result.is_ok(),"error":result.as_ref().err().cloned().unwrap_or_default()
        }),
    );
    result
}

#[tauri::command]
fn store_telegram_tool_messages(state: State<'_, AppState>, input: workspace::TelegramStoreInput) -> Result<workspace::TelegramStoreResult, String> {
    workspace::store_telegram_tool_messages(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn query_telegram_tool_messages(state: State<'_, AppState>, input: workspace::TelegramQueueQuery) -> Result<workspace::TelegramToolMessagePage, String> {
    workspace::query_telegram_tool_messages(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn telegram_tool_message_keys(state: State<'_, AppState>, input: workspace::TelegramQueueQuery) -> Result<Vec<String>, String> {
    workspace::telegram_tool_message_keys(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn get_telegram_tool_messages(state: State<'_, AppState>, tool: String, keys: Vec<workspace::TelegramMessageKey>) -> Result<Vec<workspace::TelegramToolMessage>, String> {
    workspace::get_telegram_tool_messages(state.runtime.database_path.as_ref(), &tool, &keys)
}

#[tauri::command]
fn create_telegram_tool_message(state: State<'_, AppState>, input: workspace::TelegramMessageCreateInput) -> Result<workspace::TelegramToolMessage, String> {
    workspace::create_telegram_tool_message(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn update_telegram_tool_message(state: State<'_, AppState>, input: workspace::TelegramMessageUpdateInput) -> Result<(), String> {
    workspace::update_telegram_tool_message(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn delete_telegram_tool_messages(state: State<'_, AppState>, tool: String, keys: Vec<workspace::TelegramMessageKey>) -> Result<usize, String> {
    workspace::delete_telegram_tool_messages(state.runtime.database_path.as_ref(), &tool, &keys)
}

#[tauri::command]
fn resolve_telegram_tool_messages(state: State<'_, AppState>, input: workspace::TelegramQueueResolveInput) -> Result<usize, String> {
    workspace::resolve_telegram_tool_messages(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn create_telegram_message_run(state: State<'_, AppState>, input: workspace::TelegramMessageRunInput) -> Result<i64, String> {
    workspace::create_telegram_message_run(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
fn telegram_tool_cursor(state: State<'_, AppState>, tool: String, source_id: i64) -> Result<workspace::TelegramToolCursor, String> {
    workspace::telegram_tool_cursor(state.runtime.database_path.as_ref(), &tool, source_id)
}

#[tauri::command]
fn record_telegram_load_session(state: State<'_, AppState>, input: workspace::TelegramLoadSessionInput) -> Result<i64, String> {
    workspace::record_telegram_load_session(state.runtime.database_path.as_ref(), input)
}

#[tauri::command]
async fn telegram_user_mark_read(state: State<'_, AppState>, source_id: i64, message_id: i32) -> Result<(), String> {
    let external_id = workspace::telegram_user_source_external_id(state.runtime.database_path.as_ref(), source_id)?;
    let lease = state.cloud_sync.acquire_telegram_lease(state.runtime.database_path.as_ref(), "personal", &external_id).await?;
    let mut remote_result = state.telegram_user.mark_read_through(&external_id, message_id).await;
    if let Some(lease) = lease {
        if let Err(error) = lease.release().await {
            if remote_result.is_ok() { remote_result = Err(error); }
        }
    }
    let remote_error = remote_result.as_ref().err().cloned().unwrap_or_default();
    let local_result = workspace::update_telegram_read_result(
        state.runtime.database_path.as_ref(),
        source_id,
        message_id as i64,
        &remote_error,
    );
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if remote_result.is_ok() && local_result.is_ok() { "INFO" } else { "WARN" },
        "telegram_user",
        "Telegram 来源标记已读",
        &serde_json::json!({"sourceId":source_id,"messageId":message_id,"ok":remote_result.is_ok() && local_result.is_ok(),"error":if !remote_error.is_empty() { remote_error.clone() } else { local_result.as_ref().err().cloned().unwrap_or_default() }}),
    );
    remote_result?;
    local_result.map_err(|error| format!("Telegram 已标记已读，但本地状态保存失败：{error}"))
}

#[tauri::command]
async fn telegram_user_logout(state: State<'_, AppState>) -> Result<telegram_user::AuthState, String> {
    state.telegram_user.logout().await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChromeBridgeInfo { pairing_code: String, extension_path: String, available: bool, error: String }

#[tauri::command]
fn chrome_bridge_info(state: State<'_, AppState>) -> ChromeBridgeInfo {
    ChromeBridgeInfo {
        pairing_code: state.chrome_bridge.as_ref().map(|bridge| bridge.pairing_code()).unwrap_or_default(),
        extension_path: state.extension_path.display().to_string(),
        available: state.chrome_bridge.is_some(),
        error: state.chrome_bridge_error.clone(),
    }
}

#[tauri::command]
fn enqueue_chrome_favorites(state: State<'_, AppState>, items: Vec<serde_json::Value>) -> Result<Vec<u64>, String> {
    state.chrome_bridge.as_ref().ok_or_else(|| state.chrome_bridge_error.clone()).map(|bridge| bridge.enqueue("favorite", items))
}

#[tauri::command]
fn take_chrome_results(state: State<'_, AppState>, ids: Vec<u64>) -> Result<std::collections::HashMap<u64, serde_json::Value>, String> {
    state.chrome_bridge.as_ref().ok_or_else(|| state.chrome_bridge_error.clone()).map(|bridge| bridge.take_results(&ids))
}

#[tauri::command]
fn open_chrome_extension_folder(state: State<'_, AppState>) -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(&state.extension_path).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_av123_account_window(app: AppHandle, url: String) -> Result<(), String> {
    let requested = if url.trim().is_empty() { "https://123av.com/cn/" } else { url.trim() };
    if !requested.starts_with("https://123av.com/") && !requested.starts_with("https://www.123av.com/") { return Err("只允许打开 123AV 详情链接".to_string()); }
    if let Some(window) = app.get_webview_window("av123-account") { window.navigate(requested.parse().map_err(|error| format!("123AV URL 无效：{error}"))?).map_err(|error| error.to_string())?; window.set_focus().map_err(|error| error.to_string())?; return Ok(()); }
    let url = requested.parse().map_err(|error| format!("123AV URL 无效：{error}"))?;
    WebviewWindowBuilder::new(&app, "av123-account", WebviewUrl::External(url))
        .title("123AV 账号窗口（登录状态仅保存在本应用 WebView）").inner_size(1180.0, 820.0).build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn migrate_legacy_database(state: State<'_, AppState>, source_path: String, replace: bool) -> Result<LegacyMigrationResult, String> {
    workspace::migrate_legacy(state.runtime.database_path.as_ref(), PathBuf::from(source_path).as_path(), replace)
}

#[tauri::command]
fn relocate_database(state: State<'_, AppState>, target_directory: String) -> Result<String, String> {
    let target = workspace::relocate_database(state.runtime.database_path.as_ref(), PathBuf::from(target_directory).as_path())?;
    let config = serde_json::json!({"databasePath":target.display().to_string()});
    std::fs::write(&state.database_location_config, serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(target.display().to_string())
}

#[tauri::command]
fn reset_database_location(state: State<'_, AppState>) -> Result<(), String> {
    if state.database_location_config.exists() { std::fs::remove_file(&state.database_location_config).map_err(|error| error.to_string())?; }
    Ok(())
}

#[tauri::command]
fn cloud_sync_status(state: State<'_, AppState>) -> Result<cloud_sync::CloudSyncStatus, String> {
    state.cloud_sync.status(state.runtime.database_path.as_ref())
}

#[tauri::command]
async fn cloud_sync_health(state: State<'_, AppState>, gateway_url: String) -> Result<cloud_sync::GatewayHealth, String> {
    Ok(state.cloud_sync.health(&gateway_url).await)
}

#[tauri::command]
async fn cloud_sync_pair(state: State<'_, AppState>, input: cloud_sync::PairingInput) -> Result<cloud_sync::CloudSyncStatus, String> {
    let result = state.cloud_sync.pair(state.runtime.database_path.as_ref(), input).await;
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if result.is_ok() { "INFO" } else { "ERROR" },
        "cloud_sync",
        "Windows 设备与云同步网关配对",
        &serde_json::json!({"ok":result.is_ok(),"error":result.as_ref().err().cloned().unwrap_or_default()}),
    );
    result
}

#[tauri::command]
fn cloud_sync_disconnect(state: State<'_, AppState>) -> Result<cloud_sync::CloudSyncStatus, String> {
    let result = state.cloud_sync.disconnect(state.runtime.database_path.as_ref());
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if result.is_ok() { "INFO" } else { "ERROR" },
        "cloud_sync",
        "Windows 设备断开云同步",
        &serde_json::json!({"ok":result.is_ok()}),
    );
    result
}

#[tauri::command]
async fn cloud_sync_preview(state: State<'_, AppState>) -> Result<cloud_sync::CloudSyncPreview, String> {
    let result = state.cloud_sync.preview(state.runtime.database_path.as_ref()).await;
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if result.is_ok() { "INFO" } else { "ERROR" },
        "cloud_sync",
        "生成本地与云端同步差异预览",
        &serde_json::json!({"ok":result.is_ok(),"local":result.as_ref().map(|value|value.local_count).unwrap_or(0),"remote":result.as_ref().map(|value|value.remote_count).unwrap_or(0),"error":result.as_ref().err().cloned().unwrap_or_default()}),
    );
    result
}

#[tauri::command]
async fn cloud_sync_run(state: State<'_, AppState>, input: cloud_sync::SyncRunInput) -> Result<cloud_sync::CloudSyncReport, String> {
    let backup = workspace::create_backup(state.runtime.database_path.as_ref(), Some("before-cloud-sync"))?;
    let result = state.cloud_sync.run_sync(state.runtime.database_path.as_ref(), input).await;
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if result.is_ok() { "INFO" } else { "ERROR" },
        "cloud_sync",
        "执行本地与云端数据同步",
        &serde_json::json!({"ok":result.is_ok(),"backup":backup.path,"pushed":result.as_ref().map(|value|value.pushed).unwrap_or(0),"pulled":result.as_ref().map(|value|value.pulled).unwrap_or(0),"conflicts":result.as_ref().map(|value|value.conflicts).unwrap_or(0),"error":result.as_ref().err().cloned().unwrap_or_default()}),
    );
    result
}

#[tauri::command]
fn cloud_sync_conflicts(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<cloud_sync::CloudSyncConflict>, String> {
    state
        .cloud_sync
        .list_conflicts(state.runtime.database_path.as_ref(), limit)
}

#[tauri::command]
async fn cloud_sync_resolve_conflict(
    state: State<'_, AppState>,
    conflict_id: i64,
    decision: cloud_sync::ConflictDecision,
) -> Result<cloud_sync::CloudSyncConflict, String> {
    let backup = workspace::create_backup(
        state.runtime.database_path.as_ref(),
        Some("before-cloud-conflict-resolution"),
    )?;
    let result = state
        .cloud_sync
        .resolve_conflict(state.runtime.database_path.as_ref(), conflict_id, decision)
        .await;
    let _ = workspace::append_log(
        state.runtime.database_path.as_ref(),
        if result.is_ok() { "INFO" } else { "ERROR" },
        "cloud_sync",
        "处理本地与云端同步冲突",
        &serde_json::json!({
            "ok": result.is_ok(),
            "conflictId": conflict_id,
            "backup": backup.path,
            "status": result.as_ref().map(|value| value.status.clone()).unwrap_or_default(),
            "error": result.as_ref().err().cloned().unwrap_or_default()
        }),
    );
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = std::env::var_os("TG_TOOLBOX_V05_DATA_DIR").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir).map_err(|error| std::io::Error::other(format!("创建应用数据目录失败：{error}")))?;
            let startup_trace = data_dir.join("startup-v05.log");
            let trace = |message: &str| {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&startup_trace) {
                    let _ = writeln!(file, "{} {message}", chrono::Utc::now().to_rfc3339());
                }
            };
            trace("setup:start");
            let database_location_config = data_dir.join("database-location-v05.json");
            let formal_database_path = data_dir.join("tg-content-toolbox-v05.sqlite");
            let prototype_database_path = data_dir.join("prototype-v05.sqlite");
            let previous_v05_dir = data_dir.parent().map(|parent| parent.join("com.wjl.tg-content-toolbox.next"));
            if let Some(previous_dir) = previous_v05_dir.as_ref().filter(|path| path.is_dir()) {
                let old_config = previous_dir.join("database-location-v05.json");
                if old_config.is_file() && !database_location_config.exists() { let _ = std::fs::copy(old_config, &database_location_config); }
            }
            if !formal_database_path.exists() {
                if let Some(previous_dir) = previous_v05_dir.filter(|path| path.is_dir()) {
                    for name in ["tg-content-toolbox-v05.sqlite", "prototype-v05.sqlite"] {
                        let previous_database = previous_dir.join(name);
                        if previous_database.is_file() {
                            std::fs::copy(&previous_database, &formal_database_path).map_err(|error| std::io::Error::other(format!("复制早期 v0.5 数据库失败：{error}")))?;
                            for companion in ["telegram-user-credentials-v05.bin", "telegram-user-session-v05.bin"] {
                                let old = previous_dir.join(companion); let new = data_dir.join(companion);
                                if old.is_file() && !new.exists() { let _ = std::fs::copy(old, new); }
                            }
                            break;
                        }
                    }
                }
            }
            if !formal_database_path.exists() && prototype_database_path.exists() {
                if std::fs::rename(&prototype_database_path, &formal_database_path).is_err() {
                    std::fs::copy(&prototype_database_path, &formal_database_path).map_err(|error| std::io::Error::other(format!("迁移早期 v0.5 数据库失败：{error}")))?;
                }
            }
            let database_path = std::fs::read_to_string(&database_location_config).ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|value| value.get("databasePath").and_then(|path| path.as_str()).map(PathBuf::from))
                .filter(|path| path.is_file())
                .unwrap_or(formal_database_path);
            let missav_blacklist_directory = missav_blacklists::resolve_default_directory()
                .map_err(std::io::Error::other)?;
            missav_blacklists::ensure_files(&missav_blacklist_directory)
                .map_err(std::io::Error::other)?;
            trace("setup:initializing_database");
            database::initialize(&database_path).map_err(|error| std::io::Error::other(format!("初始化正式数据库失败：{error}")))?;
            trace("setup:database_ready");
            let extension_path = data_dir.join("chrome-extension-v05");
            let bridge_start = chrome_bridge::install_extension(&extension_path)
                .and_then(|_| chrome_bridge::ChromeBridge::start());
            let (chrome_bridge, chrome_bridge_error) = match bridge_start {
                Ok(bridge) => (Some(bridge), String::new()),
                Err(error) => {
                    let message = format!("Chrome 扩展桥未能启动：{error}。不影响其他工具；可使用 APP 内串行助手或仅导出。");
                    let _ = workspace::append_log(&database_path, "WARNING", "chrome_bridge", "Chrome 扩展桥不可用", &serde_json::json!({"error":error}));
                    (None, message)
                }
            };
            app.manage(AppState {
                runtime: RuntimeState {
                    database_path: Arc::new(database_path),
                },
                chrome_bridge,
                chrome_bridge_error,
                extension_path,
                database_location_config,
                missav_blacklist_directory,
                telegram_user: Arc::new(telegram_user::TelegramUserRuntime::new(&data_dir)),
                cloud_sync: Arc::new(cloud_sync::CloudSyncRuntime::new(&data_dir).map_err(std::io::Error::other)?),
            });
            trace("setup:ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            analyze_legacy_database,
            create_content_run,
            list_content_runs,
            get_content_run,
            rename_content_run,
            delete_content_run,
            update_content_result,
            delete_content_results,
            query_permanent_records,
            query_permanent_record_ids,
            update_permanent_record,
            update_permanent_records,
            delete_permanent_records,
            list_input_sources,
            save_input_source,
            update_tool_source_bindings,
            delete_input_source,
            known_telegram_message_ids,
            commit_telegram_sync,
            list_inbox_tasks,
            update_inbox_task_stage,
            record_script_generation,
            get_app_setting,
            set_app_setting,
            read_missav_blacklist_files,
            write_missav_blacklist_file,
            open_missav_blacklist_folder,
            append_app_log,
            list_app_logs,
            create_database_backup,
            list_database_backups,
            restore_database_backup,
            read_input_files,
            write_text_file,
            fetch_site_page,
            call_telegram_bot,
            telegram_user_status,
            telegram_user_connect,
            telegram_user_start_phone,
            telegram_user_submit_code,
            telegram_user_submit_password,
            telegram_user_qr_step,
            telegram_user_qr_poll,
            telegram_user_cancel_auth,
            telegram_user_list_dialogs,
            telegram_user_sync_messages,
            telegram_user_load_history,
            store_telegram_tool_messages,
            query_telegram_tool_messages,
            telegram_tool_message_keys,
            get_telegram_tool_messages,
            create_telegram_tool_message,
            update_telegram_tool_message,
            delete_telegram_tool_messages,
            resolve_telegram_tool_messages,
            create_telegram_message_run,
            telegram_tool_cursor,
            record_telegram_load_session,
            telegram_user_mark_read,
            telegram_user_logout,
            chrome_bridge_info,
            enqueue_chrome_favorites,
            take_chrome_results
            ,open_chrome_extension_folder,
            open_av123_account_window
            ,migrate_legacy_database
            ,relocate_database,
            reset_database_location
            ,cloud_sync_status,
            cloud_sync_health,
            cloud_sync_pair,
            cloud_sync_disconnect,
            cloud_sync_preview,
            cloud_sync_run,
            cloud_sync_conflicts,
            cloud_sync_resolve_conflict
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TG Content Toolbox v0.5");
}

mod database;
mod chrome_bridge;
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
    telegram_user: Arc<telegram_user::TelegramUserRuntime>,
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
fn update_permanent_record(state: State<'_, AppState>, update: workspace::PermanentUpdate) -> Result<(), String> {
    workspace::update_permanent(state.runtime.database_path.as_ref(), update)
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
fn delete_input_source(state: State<'_, AppState>, source_id: i64) -> Result<(), String> {
    workspace::delete_source(state.runtime.database_path.as_ref(), source_id)
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
    let allowed = ["txt", "html", "htm", "md", "json", "csv", "log"];
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
async fn call_raindrop(state: State<'_, AppState>, input: network::RaindropRequest) -> Result<network::HttpResponse, String> {
    let path = input.path.clone(); let method = input.method.clone();
    let result = network::raindrop_request(input).await;
    match &result {
        Ok(response) => { let _ = workspace::append_log(state.runtime.database_path.as_ref(), "INFO", "raindrop", "Raindrop 请求完成", &serde_json::json!({"method":method,"path":path,"status":response.status_code,"durationMs":response.duration_ms})); },
        Err(error) => { let _ = workspace::append_log(state.runtime.database_path.as_ref(), "ERROR", "raindrop", "Raindrop 请求失败", &serde_json::json!({"method":method,"path":path,"error":error})); },
    }
    result
}

#[tauri::command]
async fn call_telegram_bot(state: State<'_, AppState>, input: network::TelegramBotRequest) -> Result<network::HttpResponse, String> {
    let method = input.method.clone();
    let result = network::telegram_bot_request(input).await;
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
    let result = state.telegram_user.sync_messages(input).await;
    let _ = workspace::append_log(state.runtime.database_path.as_ref(), if result.is_ok() { "INFO" } else { "ERROR" }, "telegram_user", "Telegram 个人账号增量同步", &serde_json::json!({"sourceId":source_id,"count":result.as_ref().map(|row|row.messages.len()).unwrap_or(0),"ok":result.is_ok()}));
    result
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
                            for companion in ["telegram-user-credentials-v05.bin", "telegram-user-session-v05.sqlite"] {
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
                telegram_user: Arc::new(telegram_user::TelegramUserRuntime::new(&data_dir)),
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
            update_permanent_record,
            delete_permanent_records,
            list_input_sources,
            save_input_source,
            delete_input_source,
            get_app_setting,
            set_app_setting,
            append_app_log,
            list_app_logs,
            create_database_backup,
            list_database_backups,
            restore_database_backup,
            read_input_files,
            write_text_file,
            fetch_site_page,
            call_raindrop
            ,call_telegram_bot,
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
            telegram_user_logout,
            chrome_bridge_info,
            enqueue_chrome_favorites,
            take_chrome_results
            ,open_chrome_extension_folder,
            open_av123_account_window
            ,migrate_legacy_database
            ,relocate_database,
            reset_database_location
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TG Content Toolbox v0.5");
}

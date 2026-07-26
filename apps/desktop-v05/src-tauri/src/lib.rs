mod database;
mod models;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use models::{MigrationReport, RecordPage, RecordUpdate, TaskProgress, TaskSummary};

#[derive(Clone)]
struct RuntimeState {
    database_path: Arc<PathBuf>,
    active_tasks: Arc<Mutex<HashSet<i64>>>,
}

struct AppState {
    runtime: RuntimeState,
    recovered_tasks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrototypeInfo {
    version: &'static str,
    database_path: String,
    record_count: i64,
    recovered_tasks: usize,
}

#[tauri::command]
fn prototype_info(state: State<'_, AppState>) -> Result<PrototypeInfo, String> {
    Ok(PrototypeInfo {
        version: env!("CARGO_PKG_VERSION"),
        database_path: state.runtime.database_path.display().to_string(),
        record_count: database::record_count(state.runtime.database_path.as_ref())?,
        recovered_tasks: state.recovered_tasks,
    })
}

#[tauri::command]
fn seed_prototype_records(state: State<'_, AppState>, count: u32) -> Result<i64, String> {
    database::seed_records(state.runtime.database_path.as_ref(), count)
}

#[tauri::command]
fn query_prototype_records(
    state: State<'_, AppState>,
    page: u32,
    page_size: u32,
    search: String,
) -> Result<RecordPage, String> {
    database::query_records(
        state.runtime.database_path.as_ref(),
        page,
        page_size,
        &search,
    )
}

#[tauri::command]
fn update_prototype_record(state: State<'_, AppState>, update: RecordUpdate) -> Result<(), String> {
    database::update_record(
        state.runtime.database_path.as_ref(),
        update.id,
        &update.field,
        &update.value,
    )
}

#[tauri::command]
fn create_demo_task(
    state: State<'_, AppState>,
    total: u32,
    item_delay_ms: u64,
) -> Result<i64, String> {
    database::create_demo_task(state.runtime.database_path.as_ref(), total, item_delay_ms)
}

#[tauri::command]
fn list_demo_tasks(state: State<'_, AppState>) -> Result<Vec<TaskSummary>, String> {
    database::list_tasks(state.runtime.database_path.as_ref())
}

fn emit_task(app: &AppHandle, runtime: &RuntimeState, task_id: i64, current_item: Option<String>) {
    if let Ok(task) = database::get_task(runtime.database_path.as_ref(), task_id) {
        let _ = app.emit(
            "prototype-task-progress",
            TaskProgress { task, current_item },
        );
    }
}

fn launch_worker(app: AppHandle, runtime: RuntimeState, task_id: i64) -> Result<(), String> {
    database::set_task_status(runtime.database_path.as_ref(), task_id, "running")?;
    {
        let mut active = runtime.active_tasks.lock();
        if !active.insert(task_id) {
            return Ok(());
        }
    }
    emit_task(&app, &runtime, task_id, None);

    tauri::async_runtime::spawn(async move {
        let delay_ms =
            database::task_delay_ms(runtime.database_path.as_ref(), task_id).unwrap_or(30);
        loop {
            let task = match database::get_task(runtime.database_path.as_ref(), task_id) {
                Ok(task) => task,
                Err(_) => break,
            };
            if task.status != "running" {
                break;
            }

            match database::take_next_item(runtime.database_path.as_ref(), task_id) {
                Ok(Some(item)) => {
                    emit_task(&app, &runtime, task_id, Some(item.value.clone()));
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    if database::complete_task_item(
                        runtime.database_path.as_ref(),
                        task_id,
                        item.id,
                    )
                    .is_err()
                    {
                        break;
                    }
                    emit_task(&app, &runtime, task_id, Some(item.value));
                }
                Ok(None) => {
                    let _ = database::finish_task_if_empty(runtime.database_path.as_ref(), task_id);
                    emit_task(&app, &runtime, task_id, None);
                    break;
                }
                Err(_) => break,
            }
        }
        runtime.active_tasks.lock().remove(&task_id);
        emit_task(&app, &runtime, task_id, None);
        if database::get_task(runtime.database_path.as_ref(), task_id)
            .map(|task| task.status == "running")
            .unwrap_or(false)
        {
            let _ = launch_worker(app.clone(), runtime.clone(), task_id);
        }
    });
    Ok(())
}

#[tauri::command]
fn start_demo_task(app: AppHandle, state: State<'_, AppState>, task_id: i64) -> Result<(), String> {
    launch_worker(app, state.runtime.clone(), task_id)
}

#[tauri::command]
fn pause_demo_task(app: AppHandle, state: State<'_, AppState>, task_id: i64) -> Result<(), String> {
    database::set_task_status(state.runtime.database_path.as_ref(), task_id, "paused")?;
    emit_task(&app, &state.runtime, task_id, None);
    Ok(())
}

#[tauri::command]
fn cancel_demo_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: i64,
) -> Result<(), String> {
    database::set_task_status(state.runtime.database_path.as_ref(), task_id, "cancelled")?;
    emit_task(&app, &state.runtime, task_id, None);
    Ok(())
}

#[tauri::command]
fn analyze_legacy_database(path: String) -> Result<MigrationReport, String> {
    database::analyze_legacy_database(PathBuf::from(path).as_path())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let database_path = data_dir.join("prototype-v05.sqlite");
            database::initialize(&database_path).map_err(|error| std::io::Error::other(error))?;
            let recovered_tasks = database::recover_interrupted_tasks(&database_path)
                .map_err(|error| std::io::Error::other(error))?;
            app.manage(AppState {
                runtime: RuntimeState {
                    database_path: Arc::new(database_path),
                    active_tasks: Arc::new(Mutex::new(HashSet::new())),
                },
                recovered_tasks,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prototype_info,
            seed_prototype_records,
            query_prototype_records,
            update_prototype_record,
            create_demo_task,
            list_demo_tasks,
            start_demo_task,
            pause_demo_task,
            cancel_demo_task,
            analyze_legacy_database
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TG Content Toolbox v0.5 prototype");
}

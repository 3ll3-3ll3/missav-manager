import { invoke } from "@tauri-apps/api/core";
import type {
  MigrationReport,
  AppLogEntry,
  BackupInfo,
  CreateRunInput,
  ReadInputFile,
  RunDetail,
  RunSummary,
  SourceInput,
  SourceRecord,
  AppInfo,
  HttpResponse,
  PermanentPage,
  ChromeBridgeInfo,
  LegacyMigrationResult,
  TelegramAuthState,
  TelegramDialog,
  TelegramSyncResult,
} from "./types";

export function getAppInfo(): Promise<AppInfo> {
  return invoke("app_info");
}

export function analyzeLegacyDatabase(path: string): Promise<MigrationReport> {
  return invoke("analyze_legacy_database", { path });
}

export function createContentRun(input: CreateRunInput): Promise<number> {
  return invoke("create_content_run", { input });
}

export function listContentRuns(tool: string | null, search = "", limit = 200): Promise<RunSummary[]> {
  return invoke("list_content_runs", { tool, search, limit });
}

export function getContentRun(runId: number): Promise<RunDetail> {
  return invoke("get_content_run", { runId });
}

export function renameContentRun(runId: number, name: string): Promise<void> {
  return invoke("rename_content_run", { runId, name });
}

export function deleteContentRun(runId: number): Promise<void> {
  return invoke("delete_content_run", { runId });
}

export function updateContentResult(id: number, field: string, value: unknown): Promise<void> {
  return invoke("update_content_result", { update: { id, field, value } });
}

export function deleteContentResults(ids: number[]): Promise<number> {
  return invoke("delete_content_results", { ids });
}

export function listInputSources(): Promise<SourceRecord[]> {
  return invoke("list_input_sources");
}

export function saveInputSource(input: SourceInput): Promise<number> {
  return invoke("save_input_source", { input });
}

export function deleteInputSource(sourceId: number): Promise<void> {
  return invoke("delete_input_source", { sourceId });
}

export function getAppSetting<T>(key: string): Promise<T | null> {
  return invoke("get_app_setting", { key });
}

export function setAppSetting(key: string, value: unknown): Promise<void> {
  return invoke("set_app_setting", { key, value });
}

export function appendAppLog(
  level: string,
  category: string,
  message: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  return invoke("append_app_log", { level, category, message, details });
}

export function listAppLogs(limit = 1000, level = "", search = ""): Promise<AppLogEntry[]> {
  return invoke("list_app_logs", { limit, level, search });
}

export function createDatabaseBackup(label?: string): Promise<BackupInfo> {
  return invoke("create_database_backup", { label });
}

export function listDatabaseBackups(): Promise<BackupInfo[]> {
  return invoke("list_database_backups");
}

export function restoreDatabaseBackup(backupPath: string): Promise<void> {
  return invoke("restore_database_backup", { backupPath });
}

export function readInputFiles(paths: string[]): Promise<ReadInputFile[]> {
  return invoke("read_input_files", { paths });
}

export function writeTextFile(path: string, content: string): Promise<void> {
  return invoke("write_text_file", { path, content });
}

export function fetchSitePage(url: string, proxy = "", timeoutMs = 15_000): Promise<HttpResponse> {
  return invoke("fetch_site_page", { url, proxy, timeoutMs });
}

export function callRaindrop(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  token: string,
  body?: Record<string, unknown>,
  proxy = "",
): Promise<HttpResponse> {
  return invoke("call_raindrop", { input: { method, path, token, body, proxy } });
}

export function queryPermanentRecords(tool = "", page = 1, pageSize = 200, search = ""): Promise<PermanentPage> {
  return invoke("query_permanent_records", { tool, page, pageSize, search });
}
export function updatePermanentRecord(id: number, field: string, value: unknown): Promise<void> {
  return invoke("update_permanent_record", { update: { id, field, value } });
}
export function deletePermanentRecords(ids: number[]): Promise<number> {
  return invoke("delete_permanent_records", { ids });
}

export function callTelegramBot(token: string, method: string, body: Record<string, unknown> = {}, proxy = ""): Promise<HttpResponse> {
  return invoke("call_telegram_bot", { input: { token, method, body, proxy } });
}

export function telegramUserStatus(): Promise<TelegramAuthState> { return invoke("telegram_user_status"); }
export function telegramUserConnect(): Promise<TelegramAuthState> { return invoke("telegram_user_connect"); }
export function telegramUserStartPhone(apiId: number, apiHash: string, phone: string, proxyUrl = ""): Promise<TelegramAuthState> {
  return invoke("telegram_user_start_phone", { apiId, apiHash, phone, proxyUrl });
}
export function telegramUserSubmitCode(code: string): Promise<TelegramAuthState> { return invoke("telegram_user_submit_code", { code }); }
export function telegramUserSubmitPassword(password: string): Promise<TelegramAuthState> { return invoke("telegram_user_submit_password", { password }); }
export function telegramUserQrStep(apiId: number, apiHash: string, proxyUrl = ""): Promise<TelegramAuthState> {
  return invoke("telegram_user_qr_step", { apiId, apiHash, proxyUrl });
}
export function telegramUserListDialogs(limit = 1000): Promise<TelegramDialog[]> { return invoke("telegram_user_list_dialogs", { limit }); }
export function telegramUserSyncMessages(input: { externalId: string; checkpoint: number; limit: number; start: string; end: string }): Promise<TelegramSyncResult> {
  return invoke("telegram_user_sync_messages", { input });
}
export function telegramUserLogout(): Promise<TelegramAuthState> { return invoke("telegram_user_logout"); }
export function getChromeBridgeInfo(): Promise<ChromeBridgeInfo> { return invoke("chrome_bridge_info"); }
export function enqueueChromeFavorites(items: Array<Record<string, unknown>>): Promise<number[]> { return invoke("enqueue_chrome_favorites", { items }); }
export function takeChromeResults(ids: number[]): Promise<Record<string, Record<string, unknown>>> { return invoke("take_chrome_results", { ids }); }
export function openChromeExtensionFolder(): Promise<void> { return invoke("open_chrome_extension_folder"); }
export function openAv123AccountWindow(url = ""): Promise<void> { return invoke("open_av123_account_window", { url }); }
export function migrateLegacyDatabase(sourcePath: string, replace = false): Promise<LegacyMigrationResult> { return invoke("migrate_legacy_database", { sourcePath, replace }); }
export function relocateDatabase(targetDirectory: string): Promise<string> { return invoke("relocate_database", { targetDirectory }); }
export function resetDatabaseLocation(): Promise<void> { return invoke("reset_database_location"); }

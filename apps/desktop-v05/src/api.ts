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
  TelegramHistoryResult,
  TelegramMessageKey,
  TelegramToolMessage,
  TelegramToolMessagePage,
  TelegramToolCursor,
  TelegramStoreResult,
  TelegramCommitResult,
  InboxTask,
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

export function updateToolSourceBindings(tool: string, updates: Array<{ sourceId: number; bound: boolean }>): Promise<number> {
  return invoke("update_tool_source_bindings", { tool, updates });
}

export function deleteInputSource(sourceId: number): Promise<void> {
  return invoke("delete_input_source", { sourceId });
}
export function knownTelegramMessageIds(sourceId: number, ids: number[]): Promise<number[]> { return invoke("known_telegram_message_ids", { sourceId, ids }); }
export function commitTelegramSync(input: { sourceId: number; checkpoint: string; continuation: string; fingerprints: Array<{ messageId: number; messageDate: string; contentHash: string }>; runs: CreateRunInput[]; safeReadMessageId?: number; readState?: string }): Promise<TelegramCommitResult> { return invoke("commit_telegram_sync", { input }); }
export function listInboxTasks(stage = "", search = "", limit = 5000): Promise<InboxTask[]> { return invoke("list_inbox_tasks", { stage, search, limit }); }
export function updateInboxTaskStage(id: number, stage: string): Promise<void> { return invoke("update_inbox_task_stage", { id, stage }); }
export function recordScriptGeneration(runId: number | null, templateVersion: string, codeCount: number): Promise<void> { return invoke("record_script_generation", { runId, templateVersion, codeCount }); }

export function getAppSetting<T>(key: string): Promise<T | null> {
  return invoke("get_app_setting", { key });
}

export function setAppSetting(key: string, value: unknown): Promise<void> {
  return invoke("set_app_setting", { key, value });
}

export interface MissavBlacklistFilesSnapshot {
  directory: string;
  referencePath: string;
  raindropExportPath: string;
  referenceText: string;
  raindropExportText: string;
}

export type MissavBlacklistFileKind = "reference" | "raindrop_export";

export function readMissavBlacklistFiles(): Promise<MissavBlacklistFilesSnapshot> {
  return invoke("read_missav_blacklist_files");
}

export function writeMissavBlacklistFile(kind: MissavBlacklistFileKind, content: string): Promise<MissavBlacklistFilesSnapshot> {
  return invoke("write_missav_blacklist_file", { kind, content });
}

export function openMissavBlacklistFolder(): Promise<void> {
  return invoke("open_missav_blacklist_folder");
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

export function queryPermanentRecords(tool = "", page = 1, pageSize = 200, search = ""): Promise<PermanentPage> {
  return invoke("query_permanent_records", { tool, page, pageSize, search });
}
export function queryPermanentRecordIds(tool = "", search = ""): Promise<number[]> {
  return invoke("query_permanent_record_ids", { tool, search });
}
export function updatePermanentRecord(id: number, field: string, value: unknown): Promise<void> {
  return invoke("update_permanent_record", { update: { id, field, value } });
}
export function updatePermanentRecords(ids: number[], field: string, value: unknown): Promise<number> {
  return invoke("update_permanent_records", { ids, field, value });
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
export function telegramUserQrPoll(confirm = false): Promise<TelegramAuthState> {
  return invoke("telegram_user_qr_poll", { confirm });
}
export function telegramUserCancelAuth(): Promise<TelegramAuthState> {
  return invoke("telegram_user_cancel_auth");
}
export function telegramUserListDialogs(limit = 1000): Promise<TelegramDialog[]> { return invoke("telegram_user_list_dialogs", { limit }); }
export function telegramUserSyncMessages(input: { externalId: string; checkpoint: number; limit: number; start: string; end: string }): Promise<TelegramSyncResult> {
  return invoke("telegram_user_sync_messages", { input });
}
export function telegramUserLoadHistory(input: { sourceId: number; tool: string; limit: number; start: string; end: string; beforeId: number; afterId: number }): Promise<TelegramHistoryResult> {
  return invoke("telegram_user_load_history", { input });
}
export interface TelegramQueueQueryInput { tool: string; sourceIds: number[]; status: string; search: string; startAt: string; endAt: string; candidateOnly: boolean; page: number; pageSize: number }
export function storeTelegramToolMessages(input: { sourceId: number; tool: string; messages: Array<{ messageId: number; messageDate: string; text: string; contentHash: string; candidateCount: number; candidatePreview: string }> }): Promise<TelegramStoreResult> {
  return invoke("store_telegram_tool_messages", { input });
}
export function queryTelegramToolMessages(input: TelegramQueueQueryInput): Promise<TelegramToolMessagePage> {
  return invoke("query_telegram_tool_messages", { input });
}
export function telegramToolMessageKeys(input: TelegramQueueQueryInput): Promise<string[]> {
  return invoke("telegram_tool_message_keys", { input });
}
export function getTelegramToolMessages(tool: string, keys: TelegramMessageKey[]): Promise<TelegramToolMessage[]> {
  return invoke("get_telegram_tool_messages", { tool, keys });
}
export function createTelegramToolMessage(input: { tool: string; sourceId: number; messageDate: string; text: string; contentHash: string; candidateCount: number; candidatePreview: string }): Promise<TelegramToolMessage> {
  return invoke("create_telegram_tool_message", { input });
}
export function updateTelegramToolMessage(input: { tool: string; sourceId: number; messageId: number; field: "messageDate" | "text"; value: string; contentHash?: string; candidateCount?: number; candidatePreview?: string }): Promise<void> {
  return invoke("update_telegram_tool_message", { input });
}
export function deleteTelegramToolMessages(tool: string, keys: TelegramMessageKey[]): Promise<number> {
  return invoke("delete_telegram_tool_messages", { tool, keys });
}
export function resolveTelegramToolMessages(input: { tool: string; keys: TelegramMessageKey[]; status: "pending" | "ignored" }): Promise<number> {
  return invoke("resolve_telegram_tool_messages", { input });
}
export function createTelegramMessageRun(input: { tool: string; keys: TelegramMessageKey[]; run: CreateRunInput }): Promise<number> {
  return invoke("create_telegram_message_run", { input });
}
export function telegramToolCursor(tool: string, sourceId: number): Promise<TelegramToolCursor> {
  return invoke("telegram_tool_cursor", { tool, sourceId });
}
export function recordTelegramLoadSession(input: { tool: string; sourceId: number; mode: string; requestedCount: number; scannedCount: number; loadedCount: number; nextBeforeId: number; nextAfterId: number; status: "completed" | "stopped" | "error"; error: string }): Promise<number> {
  return invoke("record_telegram_load_session", { input });
}
export function telegramUserMarkRead(sourceId: number, messageId: number): Promise<void> { return invoke("telegram_user_mark_read", { sourceId, messageId }); }
export function telegramUserLogout(): Promise<TelegramAuthState> { return invoke("telegram_user_logout"); }
export function getChromeBridgeInfo(): Promise<ChromeBridgeInfo> { return invoke("chrome_bridge_info"); }
export function enqueueChromeFavorites(items: Array<Record<string, unknown>>): Promise<number[]> { return invoke("enqueue_chrome_favorites", { items }); }
export function takeChromeResults(ids: number[]): Promise<Record<string, Record<string, unknown>>> { return invoke("take_chrome_results", { ids }); }
export function openChromeExtensionFolder(): Promise<void> { return invoke("open_chrome_extension_folder"); }
export function openAv123AccountWindow(url = ""): Promise<void> { return invoke("open_av123_account_window", { url }); }
export function migrateLegacyDatabase(sourcePath: string, replace = false): Promise<LegacyMigrationResult> { return invoke("migrate_legacy_database", { sourcePath, replace }); }
export function relocateDatabase(targetDirectory: string): Promise<string> { return invoke("relocate_database", { targetDirectory }); }
export function resetDatabaseLocation(): Promise<void> { return invoke("reset_database_location"); }

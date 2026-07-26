import { invoke } from "@tauri-apps/api/core";
import type {
  MigrationReport,
  PrototypeInfo,
  RecordPage,
  TaskSummary,
} from "./types";

export function getPrototypeInfo(): Promise<PrototypeInfo> {
  return invoke("prototype_info");
}

export function seedPrototypeRecords(count = 100_000): Promise<number> {
  return invoke("seed_prototype_records", { count });
}

export function queryPrototypeRecords(
  page: number,
  pageSize: number,
  search: string,
): Promise<RecordPage> {
  return invoke("query_prototype_records", { page, pageSize, search });
}

export function updatePrototypeRecord(
  id: number,
  field: string,
  value: string,
): Promise<void> {
  return invoke("update_prototype_record", { update: { id, field, value } });
}

export function createDemoTask(total: number, itemDelayMs: number): Promise<number> {
  return invoke("create_demo_task", { total, itemDelayMs });
}

export function listDemoTasks(): Promise<TaskSummary[]> {
  return invoke("list_demo_tasks");
}

export function startDemoTask(taskId: number): Promise<void> {
  return invoke("start_demo_task", { taskId });
}

export function pauseDemoTask(taskId: number): Promise<void> {
  return invoke("pause_demo_task", { taskId });
}

export function cancelDemoTask(taskId: number): Promise<void> {
  return invoke("cancel_demo_task", { taskId });
}

export function analyzeLegacyDatabase(path: string): Promise<MigrationReport> {
  return invoke("analyze_legacy_database", { path });
}

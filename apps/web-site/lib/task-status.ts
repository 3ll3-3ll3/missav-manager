export const TASK_STATUS_LABELS = {
  pending: "待处理",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  partial_completed: "部分完成",
  retry_waiting: "等待重试",
  needs_manual: "需要人工处理",
  cancelled: "已取消",
} as const;

export type TaskStatus = keyof typeof TASK_STATUS_LABELS;

export const TASK_STATUSES = Object.keys(
  TASK_STATUS_LABELS,
) as TaskStatus[];

export const LEGACY_TASK_STATUS_MAP: Record<string, TaskStatus> = {
  new: "pending",
  queued: "pending",
  filtered: "running",
  website: "running",
  processing: "running",
  in_progress: "running",
  pause: "paused",
  review: "needs_manual",
  needs_review: "needs_manual",
  needs_attention: "needs_manual",
  manual: "needs_manual",
  error: "retry_waiting",
  failed: "retry_waiting",
  retry: "retry_waiting",
  retrying: "retry_waiting",
  retry_pending: "retry_waiting",
  waiting_retry: "retry_waiting",
  partial: "partial_completed",
  partially_completed: "partial_completed",
  partial_success: "partial_completed",
  success: "completed",
  succeeded: "completed",
  done: "completed",
  complete: "completed",
  completed: "completed",
  canceled: "cancelled",
  aborted: "cancelled",
};

export function normalizeTaskStatus(value: unknown): TaskStatus {
  const status = String(value || "pending");
  if (status in TASK_STATUS_LABELS) return status as TaskStatus;
  return LEGACY_TASK_STATUS_MAP[status] || "needs_manual";
}

export function taskStatusLabel(value: unknown) {
  return TASK_STATUS_LABELS[normalizeTaskStatus(value)];
}

export function taskStatusAliases(status: TaskStatus) {
  return [
    status,
    ...Object.entries(LEGACY_TASK_STATUS_MAP)
      .filter(([, canonical]) => canonical === status)
      .map(([legacy]) => legacy),
  ];
}

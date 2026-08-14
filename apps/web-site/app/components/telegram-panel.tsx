"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolId, ToolResult } from "../../lib/types";
import type { ProcessingStats } from "../../lib/rules";
import {
  normalizeTelegramToolSyncRequest,
  type TelegramRemoteLoadMode,
} from "../../lib/telegram";
import {
  isTableRowSelected,
  selectedTableCount,
  toggleTablePage,
  toggleTableRow,
  type TableSelection,
} from "../../lib/table-selection";
import ErrorNotice, { toUiError, type UiError } from "./error-notice";

type Source = {
  id: string;
  name: string;
  chat_type?: string;
  username?: string;
  archived?: number;
  external_chat_id: string;
  connection_id: string;
  access_status?: string;
  last_sync_at?: string;
  latest_remote_message_id?: string;
  incremental_checkpoint_id?: string;
  sync_cursor_message_id?: string;
  last_error?: string;
  message_count?: number;
  pending_count?: number;
  error_count?: number;
  read_policy?: "never" | "manual" | "safe_auto";
  safe_read_message_id?: string;
  last_marked_read_message_id?: string;
  read_baseline_message_id?: string;
  last_sync_status?: string;
  last_sync_error?: string;
};

type Binding = {
  source_id: string;
  tool: ToolId;
  history_mode?: string;
};

type QueueRow = {
  id: string;
  message_id: string;
  message_date: string;
  body: string;
  body_deleted_at: string;
  event_kind: string;
  remote_edited_at: string;
  remote_deleted_at: string;
  source_id: string;
  source_name: string;
  status: string;
  candidate_count: number;
  candidate_preview?: string;
  source_type?: string;
  connection_id?: string;
  run_id?: string;
  error_message?: string;
  processed_at?: string;
};

export type TelegramProcessResult = {
  selected: number;
  resultCount: number;
  runId: string;
  snapshotId: string;
  results: ToolResult[];
  stats?: Partial<ProcessingStats>;
  timings?: Record<string, number>;
  speed?: number;
};

type TelegramSyncResult = {
  scope?: Record<string, unknown>;
  personal?: Record<string, unknown> | null;
  bot?: Record<string, unknown> | null;
  request?: Record<string, unknown>;
  stopped?: boolean;
  reusedGlobalCursor?: boolean;
};

type OperationProgress = {
  kind: "sync" | "process";
  status: "running" | "completed" | "failed";
  phase: string;
  label: string;
  current: number;
  total: number;
  resultCount: number;
};

type StreamProgress = Omit<OperationProgress, "kind" | "status"> & {
  sourceName?: string;
  scanned?: number;
  inserted?: number;
  page?: number;
  pages?: number;
  received?: number;
};

const TOOL_LABELS: Record<ToolId, string> = {
  twitter: "Twitter",
  badnews: "Bad.news",
  haijiao: "海角",
  missav: "MissAV",
  av123: "123AV",
};

const QUEUE_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  processing: "处理中",
  processed: "已处理",
  processed_empty: "空结果",
  ignored: "已忽略",
  error: "错误",
  deleted: "远端已删除",
};

function queueStatusLabel(status: string) {
  return QUEUE_STATUS_LABELS[status] || status;
}

function formatMessageDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN");
}

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function streamTelegramProcess(
  payload: Record<string, unknown>,
  onProgress: (progress: Omit<OperationProgress, "kind" | "status">) => void,
): Promise<TelegramProcessResult> {
  const response = await fetch("/api/telegram", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "process-stream", ...payload }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(body.error || "Telegram 消息处理失败");
  }
  if (!response.body) throw new Error("浏览器无法读取处理进度，请刷新后重试");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: TelegramProcessResult | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type?: string;
      progress?: Omit<OperationProgress, "kind" | "status">;
      result?: TelegramProcessResult;
      error?: string;
    };
    if (event.type === "progress" && event.progress) onProgress(event.progress);
    else if (event.type === "complete" && event.result)
      completed = event.result;
    else if (event.type === "error")
      throw new Error(event.error || "Telegram 消息处理失败");
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!completed) throw new Error("处理连接提前结束，请刷新消息状态后重试");
  return completed;
}

async function streamTelegramSync(
  payload: Record<string, unknown>,
  onProgress: (progress: StreamProgress) => void,
  signal?: AbortSignal,
): Promise<TelegramSyncResult> {
  const response = await fetch("/api/telegram", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "sync-tool-sources-stream", ...payload }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(body.error || "Telegram 同步失败");
  }
  if (!response.body) throw new Error("浏览器无法读取同步进度，请刷新后重试");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: TelegramSyncResult | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type?: string;
      progress?: StreamProgress;
      result?: TelegramSyncResult;
      error?: string;
    };
    if (event.type === "progress" && event.progress) onProgress(event.progress);
    else if (event.type === "complete" && event.result)
      completed = event.result;
    else if (event.type === "error")
      throw new Error(event.error || "Telegram 同步失败");
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!completed) throw new Error("同步连接提前结束，请刷新后重试");
  return completed;
}

function download(
  name: string,
  content: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function TelegramPanel({
  tool,
  onProcessed,
  onOpenTelegramSettings,
}: {
  tool: ToolId;
  onProcessed: (result: TelegramProcessResult) => void;
  onOpenTelegramSettings: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(),
  );
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(200);
  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [queueSourceId, setQueueSourceId] = useState("");
  const [candidateOnly, setCandidateOnly] = useState(true);
  const [errorOnly, setErrorOnly] = useState(false);
  const [historyMode, setHistoryMode] = useState<Exclude<TelegramRemoteLoadMode, "incremental">>("recent");
  const [syncLimit, setSyncLimit] = useState(1_000);
  const [syncStart, setSyncStart] = useState("");
  const [syncEnd, setSyncEnd] = useState("");
  const [sort, setSort] = useState("messageDate");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selection, setSelection] = useState<TableSelection>({
    mode: "ids",
    ids: new Set(),
  });
  const [focused, setFocused] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [editRow, setEditRow] = useState<QueueRow | null>(null);
  const [editStatus, setEditStatus] = useState<"pending" | "ignored">(
    "pending",
  );
  const [syncBusy, setSyncBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [processBusy, setProcessBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [readBusy, setReadBusy] = useState<Set<string>>(new Set());
  const [activity, setActivity] = useState<"" | "sync" | "process">("");
  const [operation, setOperation] = useState<OperationProgress | null>(null);
  const [operationDetail, setOperationDetail] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [hiddenNoiseCount, setHiddenNoiseCount] = useState(0);
  const [sourceSearch, setSourceSearch] = useState("");
  const [bindingOpen, setBindingOpen] = useState(false);
  const [bindingSources, setBindingSources] = useState<Source[]>([]);
  const [bindingRows, setBindingRows] = useState<Binding[]>([]);
  const [bindingInitial, setBindingInitial] = useState<Set<string>>(new Set());
  const [bindingDraft, setBindingDraft] = useState<Set<string>>(new Set());
  const [bindingSearch, setBindingSearch] = useState("");
  const [localMessageOpen, setLocalMessageOpen] = useState(false);
  const [localMessageSource, setLocalMessageSource] = useState("");
  const [localMessageDate, setLocalMessageDate] = useState("");
  const [localMessageText, setLocalMessageText] = useState("");
  const anchor = useRef<number | null>(null);
  const syncController = useRef<AbortController | null>(null);
  const restoredSelectionTool = useRef("");

  const loadSources = useCallback(async () => {
    try {
      const payload = await api(
        `/api/telegram?view=tool&tool=${encodeURIComponent(tool)}`,
      );
      const nextSources = (payload.sources || []).filter((source: Source) =>
        (payload.boundSourceIds || []).includes(String(source.id)),
      ) as Source[];
      setSources(nextSources);
      setSelectedSources((current) => {
        const valid = new Set(nextSources.map((source) => source.id));
        let saved: string[] = [];
        try {
          saved = JSON.parse(
            localStorage.getItem(`telegram-selection:${tool}`) || "[]",
          ) as string[];
        } catch {
          saved = [];
        }
        return new Set(
          (current.size
            ? [...current]
            : saved.length
              ? saved
              : nextSources.map((source) => source.id)
          ).filter((id) => valid.has(id)),
        );
      });
      restoredSelectionTool.current = tool;
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "无法读取当前工具绑定"));
    }
  }, [tool]);

  const loadQueue = useCallback(async () => {
    if (!selectedSources.size) {
      setRows([]);
      setTotal(0);
      setHiddenNoiseCount(0);
      return { rows: [], total: 0, hiddenNoiseCount: 0 };
    }
    const sourceIds =
      queueSourceId && selectedSources.has(queueSourceId)
        ? [queueSourceId]
        : [...selectedSources];
    const includeAuditRows = [
      "processed",
      "processed_empty",
      "ignored",
      "error",
      "deleted",
    ].includes(status);
    const params = new URLSearchParams({
      view: "queue",
      tool,
      page: String(page),
      pageSize: String(pageSize),
      status,
      search,
      start: filterStart,
      end: filterEnd,
      sort,
      direction,
      sourceIds: sourceIds.join(","),
      includeNoise:
        !candidateOnly || ["processed_empty", "error", "deleted"].includes(status)
          ? "1"
          : "0",
      includeCleaned: includeAuditRows ? "1" : "0",
      errorOnly: errorOnly ? "1" : "0",
    });
    setQueueBusy(true);
    try {
      const payload = await api(`/api/telegram?${params}`);
      setRows(payload.rows || []);
      setTotal(Number(payload.total || 0));
      setHiddenNoiseCount(Number(payload.hiddenNoiseCount || 0));
      setError(null);
      return payload;
    } catch (reason) {
      setError(toUiError(reason, "消息队列读取失败"));
      return null;
    } finally {
      setQueueBusy(false);
    }
  }, [
    tool,
    page,
    pageSize,
    status,
    search,
    filterStart,
    filterEnd,
    sort,
    direction,
    selectedSources,
    queueSourceId,
    candidateOnly,
    errorOnly,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => void loadSources(), 0);
    return () => clearTimeout(timer);
  }, [loadSources]);
  useEffect(() => {
    if (restoredSelectionTool.current !== tool) return;
    localStorage.setItem(
      `telegram-selection:${tool}`,
      JSON.stringify([...selectedSources]),
    );
  }, [selectedSources, tool]);
  useEffect(() => {
    const timer = setTimeout(() => void loadQueue(), search ? 180 : 80);
    return () => clearTimeout(timer);
  }, [loadQueue, search]);
  useEffect(() => {
    if (operation?.status !== "running") return;
    const timer = window.setInterval(
      () => setElapsedSeconds((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [operation?.status, operation?.kind]);

  const selectedCount = selectedTableCount(selection, total);
  const pageIds = rows.map((row) => row.id);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const selectedSourceRows = useMemo(
    () => sources.filter((source) => selectedSources.has(source.id)),
    [sources, selectedSources],
  );
  const visibleSources = useMemo(() => {
    const needle = sourceSearch.trim().toLowerCase();
    return needle
      ? sources.filter((source) =>
          [source.name, source.external_chat_id, source.chat_type].some(
            (value) =>
              String(value || "")
                .toLowerCase()
                .includes(needle),
          ),
        )
      : sources;
  }, [sources, sourceSearch]);
  const visibleBindingSources = useMemo(() => {
    const needle = bindingSearch.trim().toLowerCase().replace(/^@/, "");
    if (!needle) return bindingSources;
    return bindingSources.filter((source) =>
      [
        source.name,
        source.username,
        source.external_chat_id,
        source.chat_type,
      ].some((value) => String(value || "").toLowerCase().includes(needle)),
    );
  }, [bindingSearch, bindingSources]);
  const bindingAdded = [...bindingDraft].filter(
    (sourceId) => !bindingInitial.has(sourceId),
  ).length;
  const bindingRemoved = [...bindingInitial].filter(
    (sourceId) => !bindingDraft.has(sourceId),
  ).length;
  const queueSourceIds =
    queueSourceId && selectedSources.has(queueSourceId)
      ? [queueSourceId]
      : [...selectedSources];
  const filters = {
    status,
    search,
    start: filterStart,
    end: filterEnd,
    sourceIds: queueSourceIds,
    includeNoise:
      !candidateOnly || ["processed_empty", "error", "deleted"].includes(status),
    includeCleaned: [
      "processed",
      "processed_empty",
      "ignored",
      "error",
      "deleted",
    ].includes(status),
    errorOnly,
  };
  const selectionPayload =
    selection.mode === "all"
      ? { mode: "all", excludeIds: [...selection.excluded], ...filters }
      : { mode: "ids", queueIds: [...selection.ids] };

  function resetSelection() {
    setSelection({ mode: "ids", ids: new Set() });
    anchor.current = null;
  }
  function toggleSource(id: string) {
    setPage(1);
    resetSelection();
    setSelectedSources((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectRow(index: number, event: React.MouseEvent) {
    const next = toggleTableRow(
      selection,
      pageIds,
      index,
      anchor.current,
      event,
    );
    anchor.current = next.anchor;
    setSelection(next.selection);
    setFocused(index);
  }
  function sortBy(field: string) {
    if (sort === field)
      setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSort(field);
      setDirection("asc");
    }
    setPage(1);
    resetSelection();
  }

  async function refreshLocalQueue() {
    const started = performance.now();
    const queue = await loadQueue();
    const elapsed = performance.now() - started;
    if (queue)
      setNotice(
        `仅刷新本地队列完成：读取 ${Number(queue.total || 0).toLocaleString()} 条匹配记录，页面刷新 ${elapsed.toFixed(0)} ms；本次没有访问 Telegram。`,
      );
  }

  async function pullRemoteMessages(mode: TelegramRemoteLoadMode) {
    if (!selectedSources.size) {
      setError({ summary: "请先选择本次要同步的已绑定来源" });
      return;
    }
    const request = normalizeTelegramToolSyncRequest({
      tool,
      sourceIds: [...selectedSources],
      mode,
      limit: syncLimit,
      start: syncStart,
      end: syncEnd,
    });
    const controller = new AbortController();
    syncController.current = controller;
    setSyncBusy(true);
    setActivity("sync");
    setElapsedSeconds(0);
    setOperationDetail("");
    setOperation({
      kind: "sync",
      status: "running",
      phase: "syncing",
      label:
        mode === "incremental"
          ? `正在执行日常增量同步：${selectedSources.size} 个来源`
          : `正在加载历史：${selectedSources.size} 个来源`,
      current: 0,
      total: selectedSources.size,
      resultCount: 0,
    });
    setError(null);
    try {
      const result = await streamTelegramSync(
        request,
        (progress) => {
          setOperation({
            kind: "sync",
            status: progress.phase === "completed" ? "completed" : "running",
            ...progress,
          });
          setOperationDetail(
            [
              progress.sourceName ? `当前来源 ${progress.sourceName}` : "",
              progress.page ? `第 ${progress.page} 页` : "",
              progress.scanned !== undefined
                ? `扫描 ${Number(progress.scanned).toLocaleString()}`
                : "",
              progress.inserted !== undefined
                ? `保存 ${Number(progress.inserted).toLocaleString()}`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          );
        },
        controller.signal,
      );
      const personal = result.personal || {};
      const bot = result.bot || {};
      const synced = Number(personal.inserted || 0) + Number(bot.inserted || 0);
      const stopped = Boolean(result.stopped);
      const botSkipped = Boolean(bot.skipped);
      const failedSources = Number(personal.errors || 0);
      setOperation({
        kind: "sync",
        status: "completed",
        phase: "completed",
        label: stopped
          ? "已在安全批次边界停止，已提交数据已保留"
          : failedSources
            ? `远端拉取完成，${failedSources} 个来源失败可单独重试`
            : "远端拉取完成，当前工具队列已刷新",
        current: selectedSources.size,
        total: selectedSources.size,
        resultCount: synced,
      });
      const refreshStarted = performance.now();
      const [, queue] = await Promise.all([loadSources(), loadQueue()]);
      const refreshMs = performance.now() - refreshStarted;
      const candidateTotal = Number(queue?.total || 0);
      const hidden = Number(queue?.hiddenNoiseCount || 0);
      const personalTimings = (personal.timings || {}) as Record<
        string,
        unknown
      >;
      const botTimings = (bot.timings || {}) as Record<string, unknown>;
      const networkMs =
        Number(botTimings.remoteMs || 0) +
        Number(personalTimings.remoteMs || 0) +
        Number(personalTimings.connectionMs || 0) +
        Number(personalTimings.entityMs || 0);
      const databaseMs =
        Number(botTimings.databaseMs || 0) +
        Number(personalTimings.databaseMs || 0);
      const totalMs =
        Number(botTimings.totalMs || 0) + Number(personalTimings.totalMs || 0);
      setOperationDetail(
        `Bot ${Number(bot.pages || 0)} 页 · Telegram 连接/网络 ${networkMs.toFixed(0)} ms · D1 入库与队列分发 ${databaseMs.toFixed(0)} ms · 页面刷新 ${refreshMs.toFixed(0)} ms · 总计 ${totalMs.toFixed(0)} ms`,
      );
      setNotice(
        `${stopped ? "安全停止完成" : "远端拉取完成"}：模式 ${request.mode}，每来源上限 ${request.limit.toLocaleString()}；个人扫描 ${Number(personal.scanned || 0)}，Bot ${botSkipped ? "历史模式不读取（保留全局单游标）" : `${Number(bot.pages || 0)} 页`} / 新增 ${Number(personal.inserted || 0) + Number(bot.inserted || 0)}，重复 ${Number(personal.duplicates || 0) + Number(bot.duplicates || 0)}，编辑 ${Number(personal.edited || 0) + Number(bot.edited || 0)}，删除 ${Number(personal.deleted || 0) + Number(bot.deleted || 0)}，失败来源 ${failedSources}；当前筛选匹配 ${candidateTotal} 条，默认隐藏无候选噪声 ${hidden} 条。`,
      );
      setError(null);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        setNotice(
          "安全停止请求已发送：服务端会在当前 Telegram 分页与 D1 事务边界停止；已提交的 offset、检查点和消息不会回退。请稍后点击“仅刷新本地队列”。",
        );
        setOperation((current) => ({
          kind: "sync",
          status: "completed",
          phase: "stopping",
          label: "正在安全停止；已提交批次已保留",
          current: current?.current || 0,
          total: current?.total || selectedSources.size,
          resultCount: current?.resultCount || 0,
        }));
      } else {
        setError(toUiError(reason, "工具内远端拉取失败"));
        setOperation({
          kind: "sync",
          status: "failed",
          phase: "failed",
          label: "远端拉取未完成；已提交批次可从断点继续",
          current: 0,
          total: selectedSources.size,
          resultCount: 0,
        });
      }
    } finally {
      syncController.current = null;
      setSyncBusy(false);
      setActivity("");
    }
  }

  function requestSafeStop() {
    if (!syncController.current) return;
    setOperationDetail("正在请求安全停止；当前远端页与本地事务完成后生效");
    syncController.current.abort();
  }

  async function processPayload(
    payload: Record<string, unknown>,
    label: string,
  ) {
    setProcessBusy(true);
    setActivity("process");
    setElapsedSeconds(0);
    setOperationDetail("");
    setOperation({
      kind: "process",
      status: "running",
      phase: "preparing",
      label: "正在准备消息处理",
      current: 0,
      total: selectedCount,
      resultCount: 0,
    });
    setError(null);
    try {
      const result = await streamTelegramProcess(
        { tool, ...payload, deleteBody: true },
        (progress) => {
          setOperation({
            kind: "process",
            status: progress.phase === "completed" ? "completed" : "running",
            ...progress,
          });
        },
      );
      setNotice(
        `${label}：处理 ${result.selected} 条，提取 ${result.resultCount} 条；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立`,
      );
      setOperation({
        kind: "process",
        status: "completed",
        phase: "completed",
        label: "处理完成，正在打开结果面板",
        current: result.selected,
        total: result.selected,
        resultCount: result.resultCount,
      });
      const timings = result.timings || {};
      setOperationDetail(
        `规则 ${Number(timings.ruleMs || 0).toFixed(0)} ms · 保存 ${Number(timings.saveMs || 0).toFixed(0)} ms · 状态与清理 ${Number(timings.updateAndCleanupMs || 0).toFixed(0)} ms · ${Number(result.speed || 0).toFixed(1)} 条/秒`,
      );
      resetSelection();
      await loadQueue();
      onProcessed(result);
    } catch (reason) {
      setError(toUiError(reason, "Telegram 消息处理失败"));
      setOperation((current) => ({
        kind: "process",
        status: "failed",
        phase: "failed",
        label: "处理未完成，请按错误提示重试",
        current: current?.current || 0,
        total: current?.total || selectedCount,
        resultCount: current?.resultCount || 0,
      }));
    } finally {
      setProcessBusy(false);
      setActivity("");
    }
  }

  async function processAllPending() {
    if (!selectedSources.size) return;
    if (
      !window.confirm(
        `一键处理当前 ${selectedSourceRows.length} 个来源的全部未处理消息？系统会先建立恢复点。`,
      )
    )
      return;
    await processPayload(
      {
        mode: "all",
        excludeIds: [],
        status: "pending",
        search,
        start: filterStart,
        end: filterEnd,
        sourceIds: queueSourceIds,
        includeNoise: false,
        includeCleaned: false,
      },
      "全部未处理消息完成",
    );
  }

  async function rerunErrors() {
    if (!selectedSources.size) return;
    await processPayload(
      {
        mode: "all",
        excludeIds: [],
        status: "error",
        search,
        start: filterStart,
        end: filterEnd,
        sourceIds: queueSourceIds,
        includeNoise: true,
        includeCleaned: true,
        errorOnly: true,
      },
      "异常消息重跑完成",
    );
  }

  async function queueStatus(
    next: "ignored" | "pending",
    payload: Record<string, unknown> = selectionPayload,
  ) {
    if (!selectedCount && !editRow) return;
    setMutationBusy(true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "queue-status",
          tool,
          ...payload,
          status: next,
        }),
      });
      setNotice(
        `已${next === "ignored" ? "忽略" : "恢复"} ${result.changed} 条；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立`,
      );
      setEditRow(null);
      resetSelection();
      await loadQueue();
    } catch (reason) {
      setError(toUiError(reason, "队列状态更新失败"));
    } finally {
      setMutationBusy(false);
    }
  }

  async function exportChosen(format: "txt" | "csv", copy = false) {
    if (!selectedCount) return;
    setExportBusy(true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "export",
          tool,
          format,
          ...selectionPayload,
        }),
      });
      if (copy) {
        await navigator.clipboard.writeText(result.content);
        setNotice(`已复制 ${result.count} 条消息`);
      } else
        download(
          `telegram-${tool}.${format}`,
          result.content,
          format === "csv" ? "text/csv;charset=utf-8" : undefined,
        );
    } catch (reason) {
      setError(toUiError(reason, copy ? "复制失败" : "导出失败"));
    } finally {
      setExportBusy(false);
    }
  }

  async function openBindingDrawer() {
    setBindingOpen(true);
    setBindingBusy(true);
    setBindingSearch("");
    try {
      const [sourcePayload, bindingPayload] = await Promise.all([
        api("/api/telegram?view=sources&page=1&pageSize=200&includeArchived=1"),
        api("/api/telegram?view=bindings"),
      ]);
      const nextSources = (sourcePayload.sources || []) as Source[];
      const nextBindings = (bindingPayload.bindings || []) as Binding[];
      const current = new Set(
        nextBindings
          .filter((binding) => binding.tool === tool)
          .map((binding) => String(binding.source_id)),
      );
      setBindingSources(nextSources);
      setBindingRows(nextBindings);
      setBindingInitial(current);
      setBindingDraft(new Set(current));
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "绑定编辑器读取失败"));
    } finally {
      setBindingBusy(false);
    }
  }

  async function saveBindingDrawer() {
    const sourceIds = new Set([
      ...bindingInitial,
      ...bindingDraft,
    ]);
    const changes = [...sourceIds]
      .filter(
        (sourceId) =>
          bindingInitial.has(sourceId) !== bindingDraft.has(sourceId),
      )
      .map((sourceId) => ({
        sourceId,
        tool,
        enabled: bindingDraft.has(sourceId),
        historyMode: "since_now",
        historyLimit: 0,
        historyFrom: "",
      }));
    if (!changes.length) {
      setBindingOpen(false);
      return;
    }
    setBindingBusy(true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save-bindings", changes }),
      });
      setNotice(
        `当前 ${TOOL_LABELS[tool]} 绑定已统一保存：新增 ${result.added}、移除 ${result.removed}；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立。`,
      );
      setBindingOpen(false);
      await loadSources();
    } catch (reason) {
      setError(toUiError(reason, "绑定保存失败"));
    } finally {
      setBindingBusy(false);
    }
  }

  async function markSourceRead(source: Source) {
    const maxId = String(source.safe_read_message_id || "");
    if (!maxId) return;
    setReadBusy((current) => new Set(current).add(source.id));
    try {
      await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "mark-read",
          sourceId: source.id,
          maxId,
        }),
      });
      setNotice(`已确认并标记 ${source.name} 已读至 #${maxId}`);
      await loadSources();
    } catch (reason) {
      setError(toUiError(reason, "Telegram 标记已读失败"));
    } finally {
      setReadBusy((current) => {
        const next = new Set(current);
        next.delete(source.id);
        return next;
      });
    }
  }

  async function createLocalMessage() {
    if (!localMessageSource || !localMessageText.trim()) return;
    setMutationBusy(true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "queue-create-local",
          tool,
          sourceId: localMessageSource,
          messageDate: localMessageDate,
          text: localMessageText,
        }),
      });
      setNotice(
        `本地测试消息已加入当前工具：预扫描 ${Number(result.candidateCount || 0)} 个候选${result.candidatePreview ? ` · ${result.candidatePreview}` : ""}`,
      );
      setLocalMessageOpen(false);
      setLocalMessageText("");
      await loadQueue();
    } catch (reason) {
      setError(toUiError(reason, "新增本地消息失败"));
    } finally {
      setMutationBusy(false);
    }
  }

  async function deleteChosenQueueRows() {
    if (!selectedCount) return;
    if (
      !window.confirm(
        `确定从当前 ${TOOL_LABELS[tool]} 工作区删除 ${selectedCount.toLocaleString()} 条本地队列记录？系统会先建立恢复点；不会删除其他工具队列或 Telegram 远端消息。`,
      )
    )
      return;
    setMutationBusy(true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "queue-delete",
          tool,
          ...selectionPayload,
        }),
      });
      setNotice(
        `已删除 ${Number(result.deleted || 0).toLocaleString()} 条本地队列记录；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立。`,
      );
      resetSelection();
      await loadQueue();
    } catch (reason) {
      setError(toUiError(reason, "删除本地队列记录失败"));
    } finally {
      setMutationBusy(false);
    }
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,textarea,select,button"))
      return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection({ mode: "all", excluded: new Set() });
    } else if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void exportChosen("txt", true);
    } else if (event.key === "Delete") {
      event.preventDefault();
      void deleteChosenQueueRows();
    } else if (event.key === "Enter" && rows[focused]) {
      event.preventDefault();
      setEditRow(rows[focused]);
      setEditStatus(rows[focused].status === "ignored" ? "ignored" : "pending");
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setFocused((value) =>
        Math.max(
          0,
          Math.min(rows.length - 1, value + (event.key === "ArrowUp" ? -1 : 1)),
        ),
      );
    }
  }

  const columns = ["source", "date", "status", "body", "result", "audit"];
  const operationElapsed = operation ? elapsedSeconds : 0;
  const operationPercent = operation?.total
    ? Math.min(100, Math.round((operation.current / operation.total) * 100))
    : 0;
  const operationSpeed =
    operationElapsed > 0 && operation?.current
      ? operation.current / operationElapsed
      : 0;
  const operationEta =
    operationSpeed > 0 &&
    operation?.total &&
    operation.current < operation.total &&
    operationElapsed >= 2
      ? Math.ceil((operation.total - operation.current) / operationSpeed)
      : 0;
  return (
    <div
      className="telegram-workspace stack-md"
      tabIndex={0}
      onKeyDown={keyboard}
    >
      <section className="callout telegram-layer-callout">
        <strong>{TOOL_LABELS[tool]}：本次选择</strong>
        <p>
          这里只选择已绑定来源；工具页复用全局连接、Bot offset、统一消息池与来源检查点，
          登录和凭据仍只由全局 Telegram 中心唯一维护。
        </p>
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Telegram 消息输入</span>
            <h3>
              本次来源：已选 {selectedSources.size} / 已绑定 {sources.length}
            </h3>
          </div>
          <div className="button-row">
            <button onClick={() => void openBindingDrawer()}>
              管理当前工具绑定
            </button>
            <button onClick={onOpenTelegramSettings}>全局连接中心</button>
          </div>
        </div>
        {!sources.length ? (
          <div className="empty compact">
            <strong>当前工具还没有绑定来源</strong>
            <p>先到全局中心为 {TOOL_LABELS[tool]} 绑定来源。</p>
            <button className="primary" onClick={() => void openBindingDrawer()}>
              在本页管理绑定
            </button>
          </div>
        ) : (
          <details className="tool-source-disclosure">
            <summary>
              <span>
                <strong>选择本次同步的群组 / 频道</strong>
                <small>默认收起；展开后可搜索并勾选，不会改变永久绑定</small>
              </span>
              <span>{selectedSources.size} 个已选</span>
            </summary>
            <div className="tool-source-picker-body">
              <div className="searchbox">
                <span>⌕</span>
                <input
                  value={sourceSearch}
                  onChange={(event) => setSourceSearch(event.target.value)}
                  placeholder="搜索群组名称、类型或 Telegram ID"
                />
              </div>
              <div className="telegram-source-picker tool-source-card-grid">
                {visibleSources.map((source) => (
                  <article
                    key={source.id}
                    className={selectedSources.has(source.id) ? "selected" : ""}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedSources.has(source.id)}
                        onChange={() => toggleSource(source.id)}
                      />
                      <span>
                        <strong>{source.name}</strong>
                        <small>
                          {source.connection_id === "telegram-personal"
                            ? "个人 API"
                            : source.connection_id === "telegram-bot"
                              ? "Bot"
                              : "官方导入"}{" "}
                          · {source.chat_type || "会话"} · {source.external_chat_id}
                        </small>
                      </span>
                      <span className="binding-state">永久已绑定</span>
                    </label>
                    <dl>
                      <div><dt>本地检查点</dt><dd>#{source.incremental_checkpoint_id || "尚未建立"}</dd></div>
                      <div><dt>待处理 / 异常</dt><dd>{Number(source.pending_count || 0).toLocaleString()} / {Number(source.error_count || 0).toLocaleString()}</dd></div>
                      <div><dt>上次同步</dt><dd>{source.last_sync_at ? formatMessageDate(source.last_sync_at) : "尚未同步"}</dd></div>
                      <div><dt>已读策略</dt><dd>{source.read_policy === "safe_auto" ? "安全自动" : source.read_policy === "manual" ? "手动确认" : "从不标已读"}</dd></div>
                      <div><dt>本站确认远端已读</dt><dd>#{source.last_marked_read_message_id || "未知"}</dd></div>
                      <div><dt>本地安全位置</dt><dd>#{source.safe_read_message_id || "尚无"}</dd></div>
                    </dl>
                    {(source.last_error || source.last_sync_error) && (
                      <details className="source-error-detail">
                        <summary>查看上次错误</summary>
                        <p>{source.last_sync_error || source.last_error}</p>
                      </details>
                    )}
                    {source.read_policy === "manual" &&
                      source.safe_read_message_id &&
                      source.safe_read_message_id !== source.last_marked_read_message_id && (
                        <button
                          disabled={readBusy.has(source.id)}
                          onClick={() => void markSourceRead(source)}
                        >
                          {readBusy.has(source.id)
                            ? "标记中…"
                            : `确认并标已读至 #${source.safe_read_message_id}`}
                        </button>
                      )}
                  </article>
                ))}
              </div>
              <div className="button-row">
                <button
                  onClick={() =>
                    setSelectedSources(
                      new Set(visibleSources.map((source) => source.id)),
                    )
                  }
                >
                  全选搜索结果
                </button>
                <button onClick={() => setSelectedSources(new Set())}>
                  清空本次选择
                </button>
              </div>
            </div>
          </details>
        )}
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">同步与历史回拉</span>
            <h3>{selectedSourceRows.length} 个来源已选择</h3>
          </div>
          <span className="subtle">最多 100 个来源</span>
        </div>
        <div className="telegram-remote-controls">
          <label>
            <span>历史加载方式</span>
            <select
              value={historyMode}
              disabled={syncBusy}
              onChange={(event) =>
                setHistoryMode(
                  event.target.value as Exclude<
                    TelegramRemoteLoadMode,
                    "incremental"
                  >,
                )
              }
            >
              <option value="recent">最近 N 条</option>
              <option value="range">指定时间范围</option>
              <option value="history">从本地最早处继续向前</option>
            </select>
          </label>
          <label>
            <span>每个来源最多扫描</span>
            <input
              type="number"
              min="1"
              max="100000"
              value={syncLimit}
              disabled={syncBusy}
              onChange={(event) =>
                setSyncLimit(
                  Math.min(
                    100_000,
                    Math.max(1, Number(event.target.value) || 1_000),
                  ),
                )
              }
            />
          </label>
          <label className={historyMode === "range" ? "" : "muted-control"}>
            <span>历史开始时间（可留空）</span>
            <input
              type="datetime-local"
              value={syncStart}
              disabled={syncBusy || historyMode !== "range"}
              onChange={(event) => setSyncStart(event.target.value)}
            />
          </label>
          <label className={historyMode === "range" ? "" : "muted-control"}>
            <span>历史结束时间（覆盖该分钟）</span>
            <input
              type="datetime-local"
              value={syncEnd}
              disabled={syncBusy || historyMode !== "range"}
              onChange={(event) => setSyncEnd(event.target.value)}
            />
          </label>
        </div>
        <div className="telegram-sync-actions">
          <button
            className="primary"
            disabled={syncBusy || !selectedSources.size}
            onClick={() => void pullRemoteMessages("incremental")}
          >
            {syncBusy && activity === "sync"
              ? "正在远端拉取…"
              : "日常增量同步"}
          </button>
          <button
            disabled={syncBusy || !selectedSources.size}
            onClick={() => void pullRemoteMessages(historyMode)}
          >
            加载历史
          </button>
          {syncBusy && (
            <button className="danger" onClick={requestSafeStop}>
              安全停止
            </button>
          )}
          <button disabled={queueBusy} onClick={() => void refreshLocalQueue()}>
            {queueBusy ? "正在读取 D1…" : "仅刷新本地队列"}
          </button>
        </div>
        <p className="subtle">
          “日常增量同步”和“加载历史”会访问 Telegram；“仅刷新本地队列”只读取
          D1。个人账号复用一次全局 Session；Bot 继续消费唯一全局 getUpdates
          offset。旧版“刷新同步消息”已拆成三个独立动作；历史回拉永远不标已读，
          也不推进日常增量检查点。
        </p>
      </section>
      {operation && (
        <section
          className={`card operation-progress-card ${operation.status}`}
          aria-live="polite"
        >
          <div className="operation-progress-heading">
            <div>
              <span className="eyebrow">
                {operation.kind === "sync" ? "同步进度" : "处理进度"}
              </span>
              <h3>{operation.label}</h3>
            </div>
            <span className="operation-progress-percent">
              {operation.status === "failed"
                ? "未完成"
                : operation.total
                  ? `${operationPercent}%`
                  : operation.status === "running"
                    ? "进行中"
                    : "完成"}
            </span>
          </div>
          <progress
            max={Math.max(1, operation.total)}
            value={
              operation.total
                ? Math.min(operation.current, operation.total)
                : undefined
            }
          />
          <div className="operation-progress-metrics">
            <span>
              {operation.total
                ? `${operation.current.toLocaleString()} / ${operation.total.toLocaleString()} ${operation.kind === "process" ? "条消息" : "个来源"}`
                : `${selectedSources.size.toLocaleString()} 个来源`}
            </span>
            <span>
              {operation.kind === "process"
                ? `已提取 ${operation.resultCount.toLocaleString()} 条结果`
                : operation.status === "completed"
                  ? `新增 ${operation.resultCount.toLocaleString()} 条消息`
                  : "复用全局连接与检查点"}
            </span>
            <span>已用时 {operationElapsed} 秒</span>
            <span>
              {operationSpeed > 0
                ? `${operationSpeed.toFixed(1)} 条/秒${operationEta ? ` · 预计 ${operationEta} 秒` : ""}`
                : "正在等待首个安全批次"}
            </span>
            {operationDetail && <span>{operationDetail}</span>}
          </div>
        </section>
      )}
      <section className="queue-filter-panel card">
        <div className="queue-filter-grid">
        <div className="searchbox">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
              resetSelection();
            }}
            placeholder="搜索正文、来源、候选、错误、任务或消息 ID"
          />
        </div>
        <select
          value={queueSourceId}
          aria-label="队列来源筛选"
          onChange={(event) => {
            setQueueSourceId(event.target.value);
            setPage(1);
            resetSelection();
          }}
        >
          <option value="">本次所选全部来源</option>
          {selectedSourceRows.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            if (event.target.value !== "error") setErrorOnly(false);
            setPage(1);
            resetSelection();
          }}
        >
          <option value="pending">待处理</option>
          <option value="processing">处理中</option>
          <option value="processed">已处理</option>
          <option value="processed_empty">空结果</option>
          <option value="ignored">已忽略</option>
          <option value="error">错误</option>
          <option value="deleted">远端已删除</option>
          <option value="">全部状态</option>
        </select>
        <input
          type="datetime-local"
          value={filterStart}
          aria-label="队列开始时间"
          onChange={(event) => {
            setFilterStart(event.target.value);
            setPage(1);
            resetSelection();
          }}
        />
        <input
          type="datetime-local"
          value={filterEnd}
          aria-label="队列结束时间"
          onChange={(event) => {
            setFilterEnd(event.target.value);
            setPage(1);
            resetSelection();
          }}
        />
        <label className="queue-filter-check">
          <input
            type="checkbox"
            checked={candidateOnly}
            onChange={(event) => {
              setCandidateOnly(event.target.checked);
              setPage(1);
              resetSelection();
            }}
          />
          只看有候选
        </label>
        <label className="queue-filter-check">
          <input
            type="checkbox"
            checked={errorOnly}
            onChange={(event) => {
              setErrorOnly(event.target.checked);
              if (event.target.checked) setStatus("error");
              setPage(1);
              resetSelection();
            }}
          />
          只看异常
        </label>
        </div>
        <div className="queue-filter-actions">
        <button
          onClick={() => setSelection(toggleTablePage(selection, pageIds))}
        >
          全选本页
        </button>
        <button
          onClick={() => setSelection({ mode: "all", excluded: new Set() })}
        >
          全选筛选结果
        </button>
        <button onClick={() => setColumnsOpen((value) => !value)}>
          列设置
        </button>
        <button disabled={queueBusy} onClick={() => void refreshLocalQueue()}>
          {queueBusy ? "刷新中…" : "刷新列表"}
        </button>
        </div>
      </section>
      {columnsOpen && (
        <section className="card result-columns">
          <strong>显示列</strong>
          {columns.map((column) => (
            <label key={column}>
              <input
                type="checkbox"
                checked={!hidden.has(column)}
                onChange={(event) =>
                  setHidden((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.delete(column);
                    else next.add(column);
                    return next;
                  })
                }
              />
              {
                {
                  source: "来源",
                  date: "时间 / ID",
                  status: "状态",
                  body: "正文",
                  result: "候选",
                  audit: "任务 / 错误",
                }[column]
              }
            </label>
          ))}
        </section>
      )}
      {selectedCount > 0 && (
        <section
          className="bulkbar telegram-bulkbar"
          aria-label="所选 Telegram 消息批量操作"
        >
          <div className="bulkbar-selection">
            <span>当前选择</span>
            <strong>{selectedCount.toLocaleString()} 条消息</strong>
          </div>
          <div className="bulkbar-group">
            <span>处理状态</span>
            <div className="bulkbar-buttons">
              <button
                className="primary"
                disabled={processBusy || mutationBusy}
                onClick={() =>
                  void processPayload(selectionPayload, "所选消息完成")
                }
              >
                {activity === "process" ? "处理中…" : "处理所选"}
              </button>
              <button
                disabled={processBusy || mutationBusy}
                onClick={() => void queueStatus("ignored")}
              >
                标为已忽略
              </button>
              <button
                disabled={processBusy || mutationBusy}
                onClick={() => void queueStatus("pending")}
              >
                恢复待处理
              </button>
            </div>
          </div>
          <div className="bulkbar-group">
            <span>复制 / 导出</span>
            <div className="bulkbar-buttons">
              <button
                disabled={exportBusy}
                onClick={() => void exportChosen("txt", true)}
              >
                复制所选消息
              </button>
              <button disabled={exportBusy} onClick={() => void exportChosen("txt")}>
                导出 TXT
              </button>
              <button disabled={exportBusy} onClick={() => void exportChosen("csv")}>
                导出 CSV
              </button>
            </div>
          </div>
          <div className="bulkbar-group">
            <span>本地记录</span>
            <div className="bulkbar-buttons">
              <button
                className="danger"
                disabled={mutationBusy || processBusy}
                onClick={() => void deleteChosenQueueRows()}
              >
                删除本地所选记录
              </button>
            </div>
          </div>
          <button
            className="bulkbar-clear"
            disabled={mutationBusy || processBusy}
            onClick={resetSelection}
          >
            清除选择
          </button>
        </section>
      )}
      {error && (
        <ErrorNotice
          error={error}
          retry={() => void Promise.all([loadSources(), loadQueue()])}
        />
      )}
      {notice && <div className="notice">{notice}</div>}
      <section className="table-card telegram-table-card">
        <div className="table-meta">
          <span>{total.toLocaleString()} 条可处理消息</span>
          <div className="button-row">
            <button
              disabled={mutationBusy || !selectedSources.size}
              onClick={() => {
                setLocalMessageSource(
                  queueSourceIds[0] || selectedSourceRows[0]?.id || "",
                );
                setLocalMessageDate("");
                setLocalMessageOpen(true);
              }}
            >
              新增本地消息
            </button>
            <button
              disabled={processBusy || !selectedSources.size}
              onClick={() => void rerunErrors()}
            >
              重跑异常
            </button>
            <button
              className="primary"
              disabled={processBusy || !selectedSources.size}
              onClick={() => void processAllPending()}
            >
              {activity === "process" ? "处理中…" : "一键处理所有未处理"}
            </button>
          </div>
        </div>
        <div className="table-scroll desktop-only">
          <table className="sheet">
            <thead>
              <tr>
                <th
                  className="check"
                  onClick={() =>
                    setSelection(toggleTablePage(selection, pageIds))
                  }
                >
                  <input
                    readOnly
                    type="checkbox"
                    checked={
                      rows.length > 0 &&
                      rows.every((row) => isTableRowSelected(selection, row.id))
                    }
                  />
                </th>
                {!hidden.has("source") && (
                  <th onClick={() => sortBy("source")}>来源</th>
                )}
                {!hidden.has("date") && (
                  <th onClick={() => sortBy("messageDate")}>时间 / ID</th>
                )}
                {!hidden.has("status") && (
                  <th onClick={() => sortBy("status")}>状态</th>
                )}
                {!hidden.has("body") && <th>消息正文</th>}
                {!hidden.has("result") && <th>候选数 / 候选预览</th>}
                {!hidden.has("audit") && <th>任务 ID / 错误备注</th>}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.id}
                  className={
                    isTableRowSelected(selection, row.id) ? "selected" : ""
                  }
                  onClick={(event) => selectRow(index, event)}
                  onDoubleClick={() => {
                    setEditRow(row);
                    setEditStatus(
                      row.status === "ignored" ? "ignored" : "pending",
                    );
                  }}
                >
                  <td className="check">
                    <input
                      readOnly
                      type="checkbox"
                      checked={isTableRowSelected(selection, row.id)}
                    />
                  </td>
                  {!hidden.has("source") && (
                    <td>
                      <strong>{row.source_name}</strong>
                      <small className="cell-note">
                        {row.connection_id === "telegram-personal"
                          ? "个人 API"
                          : row.connection_id === "telegram-bot"
                            ? "Bot"
                            : "本地 / 导入"}{" "}
                        · {row.source_type || "会话"}
                      </small>
                    </td>
                  )}
                  {!hidden.has("date") && (
                    <td>
                      {formatMessageDate(row.message_date)}
                      <small className="cell-note">
                        #{row.message_id}
                        {row.event_kind === "edited" ? " · 已编辑" : ""}
                      </small>
                    </td>
                  )}
                  {!hidden.has("status") && (
                    <td>
                      <span className="status-chip">
                        {queueStatusLabel(row.status)}
                      </span>
                    </td>
                  )}
                  {!hidden.has("body") && (
                    <td className="message-body-cell">
                      {row.body ? (
                        <details>
                          <summary>
                            {row.body.length > 120
                              ? `${row.body.slice(0, 120)}…`
                              : row.body}
                          </summary>
                          <pre>{row.body}</pre>
                        </details>
                      ) : (
                        <span className="cleaned-message-note">
                          正文已按处理策略清理
                        </span>
                      )}
                    </td>
                  )}
                  {!hidden.has("result") && (
                    <td>
                      <strong>{row.candidate_count.toLocaleString()} 条</strong>
                      <small className="candidate-preview">
                        {row.candidate_preview || "当前工具没有候选"}
                      </small>
                    </td>
                  )}
                  {!hidden.has("audit") && (
                    <td className="queue-audit-cell">
                      <strong>{row.run_id ? `#${row.run_id.slice(0, 12)}` : "尚未关联任务"}</strong>
                      <small>{row.error_message || "无错误"}</small>
                    </td>
                  )}
                  <td>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditRow(row);
                        setEditStatus(
                          row.status === "ignored" ? "ignored" : "pending",
                        );
                      }}
                    >
                      编辑状态
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mobile-telegram-list mobile-only">
          {rows.map((row, index) => (
            <article
              key={row.id}
              className={`mobile-table-card ${isTableRowSelected(selection, row.id) ? "selected" : ""}`}
              onClick={(event) => selectRow(index, event)}
            >
              <div className="mobile-card-heading">
                <input
                  readOnly
                  type="checkbox"
                  checked={isTableRowSelected(selection, row.id)}
                />
                <span className="status-chip">
                  {queueStatusLabel(row.status)}
                </span>
                <span>{formatMessageDate(row.message_date)}</span>
              </div>
              <strong>
                {row.source_name} · {row.source_type || "会话"} · #{row.message_id}
              </strong>
              <p>{row.body || "正文已按处理策略清理"}</p>
              <small>
                {row.candidate_count
                  ? `${row.candidate_count} 个候选 · ${row.candidate_preview || "等待处理"}`
                  : "当前工具没有候选"}
              </small>
              {(row.run_id || row.error_message) && (
                <small className="mobile-queue-audit">
                  {row.run_id ? `任务 #${row.run_id.slice(0, 12)}` : ""}
                  {row.error_message ? ` · ${row.error_message}` : ""}
                </small>
              )}
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setEditRow(row);
                  setEditStatus(
                    row.status === "ignored" ? "ignored" : "pending",
                  );
                }}
              >
                编辑状态
              </button>
            </article>
          ))}
        </div>
        {!rows.length && (
          <div className="empty compact">
            <strong>当前筛选没有可处理消息</strong>
            <p>
              默认只展示待处理且有候选的消息；已处理、正文已清理或严格规则无候选的噪声不会混入工作列表。若旧数据曾丢失富文本链接，请使用“加载历史 · 最近 N 条”重新读取。
            </p>
            {hiddenNoiseCount > 0 && (
              <small>
                本次已隐藏 {hiddenNoiseCount.toLocaleString()} 条无候选噪声。
              </small>
            )}
          </div>
        )}
        <footer className="pagination">
          <span>
            第 {page} / {pages} 页
          </span>
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
              resetSelection();
            }}
          >
            <option value="50">50 / 页</option>
            <option value="100">100 / 页</option>
            <option value="200">200 / 页</option>
            <option value="500">500 / 页</option>
          </select>
          <button
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            上一页
          </button>
          <button
            disabled={page >= pages}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </button>
        </footer>
      </section>
      {editRow && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setEditRow(null)}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="编辑消息队列状态"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">编辑队列状态</span>
            <h3>
              {editRow.source_name} · #{editRow.message_id}
            </h3>
            <select
              value={editStatus}
              onChange={(event) =>
                setEditStatus(event.target.value as "pending" | "ignored")
              }
            >
              <option value="pending">待处理</option>
              <option value="ignored">已忽略</option>
            </select>
            <div className="button-row">
              <button
                className="primary"
                onClick={() =>
                  void queueStatus(editStatus, {
                    mode: "ids",
                    queueIds: [editRow.id],
                  })
                }
              >
                保存并建恢复点
              </button>
              <button onClick={() => setEditRow(null)}>取消</button>
            </div>
          </section>
        </div>
      )}
      {bindingOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !bindingBusy && setBindingOpen(false)}
        >
          <section
            className="modal-card telegram-binding-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`管理 ${TOOL_LABELS[tool]} Telegram 绑定`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">当前工具绑定编辑器</span>
                <h3>{TOOL_LABELS[tool]} · 群组与频道</h3>
                <p className="subtle">
                  待新增 {bindingAdded} · 待移除 {bindingRemoved} ·
                  其他工具绑定不会被本次保存修改
                </p>
              </div>
              <button disabled={bindingBusy} onClick={() => setBindingOpen(false)}>
                关闭
              </button>
            </div>
            <div className="searchbox">
              <span>⌕</span>
              <input
                value={bindingSearch}
                onChange={(event) => setBindingSearch(event.target.value)}
                placeholder="搜索会话名称、@用户名、类型或 Telegram ID"
              />
            </div>
            <div className="tool-binding-list">
              {bindingBusy && !bindingSources.length ? (
                <div className="empty compact">正在读取全局会话与绑定…</div>
              ) : (
                visibleBindingSources.map((source) => {
                  const before = bindingInitial.has(source.id);
                  const after = bindingDraft.has(source.id);
                  const others = bindingRows
                    .filter(
                      (binding) =>
                        String(binding.source_id) === source.id &&
                        binding.tool !== tool,
                    )
                    .map((binding) => TOOL_LABELS[binding.tool]);
                  return (
                    <label
                      key={source.id}
                      className={`current-binding-row ${before !== after ? "changed" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={after}
                        disabled={bindingBusy || Number(source.archived || 0) === 1}
                        onChange={(event) =>
                          setBindingDraft((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(source.id);
                            else next.delete(source.id);
                            return next;
                          })
                        }
                      />
                      <span>
                        <strong>{source.name}</strong>
                        <small>
                          @{source.username || "无用户名"} · {source.chat_type || "会话"} · {source.external_chat_id}
                        </small>
                      </span>
                      <span className="binding-state">
                        {!before && after
                          ? "待新增"
                          : before && !after
                            ? "待移除"
                            : after
                              ? "当前工具已绑定"
                              : "当前工具未绑定"}
                      </span>
                      <span className="other-bindings">
                        其他工具：{others.length ? others.join("、") : "无"}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="binding-drawer-actions">
              <span>
                这次保存只提交差异：新增 {bindingAdded}、移除 {bindingRemoved}
              </span>
              <div className="button-row">
                <button
                  onClick={() => {
                    setBindingOpen(false);
                    onOpenTelegramSettings();
                  }}
                >
                  高级入口：五列全局矩阵
                </button>
                <button
                  className="primary"
                  disabled={bindingBusy || (!bindingAdded && !bindingRemoved)}
                  onClick={() => void saveBindingDrawer()}
                >
                  {bindingBusy ? "保存中…" : "一次提交全部变化"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {localMessageOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !mutationBusy && setLocalMessageOpen(false)}
        >
          <section
            className="modal-card local-message-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="新增当前工具本地 Telegram 消息"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">消息工作表</span>
            <h3>新增本地测试消息</h3>
            <p className="subtle">
              只加入当前 {TOOL_LABELS[tool]} 队列；不会发送到 Telegram，
              不推进远端检查点，也不会分发到其他工具。
            </p>
            <label className="field">
              <span>来源</span>
              <select
                value={localMessageSource}
                onChange={(event) => setLocalMessageSource(event.target.value)}
              >
                {selectedSourceRows.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name} · {source.chat_type || "会话"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>消息时间（留空使用当前时间）</span>
              <input
                type="datetime-local"
                value={localMessageDate}
                onChange={(event) => setLocalMessageDate(event.target.value)}
              />
            </label>
            <label className="field">
              <span>消息正文</span>
              <textarea
                rows={10}
                value={localMessageText}
                onChange={(event) => setLocalMessageText(event.target.value)}
                placeholder="粘贴用于当前工具规则验证的消息正文"
              />
            </label>
            <div className="button-row">
              <button
                className="primary"
                disabled={
                  mutationBusy ||
                  !localMessageSource ||
                  !localMessageText.trim()
                }
                onClick={() => void createLocalMessage()}
              >
                {mutationBusy ? "保存中…" : "保存并预扫描候选"}
              </button>
              <button
                disabled={mutationBusy}
                onClick={() => setLocalMessageOpen(false)}
              >
                取消
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

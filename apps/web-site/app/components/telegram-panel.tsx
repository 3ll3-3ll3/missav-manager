"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolId, ToolResult } from "../../lib/types";
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
  external_chat_id: string;
  connection_id: string;
  access_status?: string;
  last_sync_at?: string;
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
};

export type TelegramProcessResult = {
  selected: number;
  resultCount: number;
  runId: string;
  snapshotId: string;
  results: ToolResult[];
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
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
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
    else if (event.type === "complete" && event.result) completed = event.result;
    else if (event.type === "error") throw new Error(event.error || "Telegram 消息处理失败");
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

function download(name: string, content: string, type = "text/plain;charset=utf-8") {
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
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [loadMode, setLoadMode] = useState<"cached" | "recent" | "range" | "history" | "incremental">("incremental");
  const [syncLimit, setSyncLimit] = useState(200);
  const [sort, setSort] = useState("messageDate");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selection, setSelection] = useState<TableSelection>({ mode: "ids", ids: new Set() });
  const [focused, setFocused] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [editRow, setEditRow] = useState<QueueRow | null>(null);
  const [editStatus, setEditStatus] = useState<"pending" | "ignored">("pending");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<"" | "sync" | "process">("");
  const [operation, setOperation] = useState<OperationProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const anchor = useRef<number | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const payload = await api(`/api/telegram?view=tool&tool=${encodeURIComponent(tool)}`);
      const nextSources = (payload.sources || []).filter((source: Source) => (payload.boundSourceIds || []).includes(String(source.id))) as Source[];
      setSources(nextSources);
      setSelectedSources((current) => {
        const valid = new Set(nextSources.map((source) => source.id));
        let saved: string[] = [];
        try { saved = JSON.parse(localStorage.getItem(`telegram-selection:${tool}`) || "[]") as string[]; } catch { saved = []; }
        return new Set((current.size ? [...current] : saved.length ? saved : nextSources.map((source) => source.id)).filter((id) => valid.has(id)));
      });
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "无法读取当前工具绑定"));
    }
  }, [tool]);

  const loadQueue = useCallback(async () => {
    if (!selectedSources.size) { setRows([]); setTotal(0); return; }
    const params = new URLSearchParams({ view: "queue", tool, page: String(page), pageSize: String(pageSize), status, search, start, end, sort, direction, sourceIds: [...selectedSources].join(",") });
    try {
      const payload = await api(`/api/telegram?${params}`);
      setRows(payload.rows || []);
      setTotal(Number(payload.total || 0));
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "消息队列读取失败"));
    }
  }, [tool, page, pageSize, status, search, start, end, sort, direction, selectedSources]);

  useEffect(() => { const timer = setTimeout(() => void loadSources(), 0); return () => clearTimeout(timer); }, [loadSources]);
  useEffect(() => { localStorage.setItem(`telegram-selection:${tool}`, JSON.stringify([...selectedSources])); }, [selectedSources, tool]);
  useEffect(() => { const timer = setTimeout(() => void loadQueue(), search ? 180 : 80); return () => clearTimeout(timer); }, [loadQueue, search]);
  useEffect(() => {
    if (operation?.status !== "running") return;
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [operation?.status, operation?.kind]);

  const selectedCount = selectedTableCount(selection, total);
  const pageIds = rows.map((row) => row.id);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const selectedSourceRows = useMemo(() => sources.filter((source) => selectedSources.has(source.id)), [sources, selectedSources]);
  const filters = { status, search, start, end, sourceIds: [...selectedSources] };
  const selectionPayload = selection.mode === "all"
    ? { mode: "all", excludeIds: [...selection.excluded], ...filters }
    : { mode: "ids", queueIds: [...selection.ids] };

  function resetSelection() { setSelection({ mode: "ids", ids: new Set() }); anchor.current = null; }
  function toggleSource(id: string) { setPage(1); resetSelection(); setSelectedSources((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function selectRow(index: number, event: React.MouseEvent) { if (rows[index].status === "deleted") return; const next = toggleTableRow(selection, pageIds, index, anchor.current, event); anchor.current = next.anchor; setSelection(next.selection); setFocused(index); }
  function sortBy(field: string) { if (sort === field) setDirection((value) => value === "asc" ? "desc" : "asc"); else { setSort(field); setDirection("asc"); } setPage(1); resetSelection(); }

  async function refreshSyncMessages() {
    if (!selectedSources.size) { setError({ summary: "请先选择本次要同步的已绑定来源" }); return; }
    if (loadMode === "cached") { await loadQueue(); setNotice("已刷新当前工具的本地统一消息池"); return; }
    setBusy(true);
    setActivity("sync");
    setElapsedSeconds(0);
    setOperation({ kind: "sync", status: "running", phase: "syncing", label: `正在同步 ${selectedSources.size} 个已绑定来源`, current: 0, total: 0, resultCount: 0 });
    setError(null);
    try {
      const result = await api("/api/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync-tool-sources", tool, sourceIds: [...selectedSources], mode: loadMode, limit: syncLimit, start, end }) });
      const personal = result.personal || {};
      const bot = result.bot || {};
      const synced = Number(personal.inserted || 0) + Number(bot.inserted || 0);
      setNotice(`刷新同步完成：个人扫描 ${Number(personal.scanned || 0)}，Bot 新增 ${Number(bot.inserted || 0)}，编辑 ${Number((personal.edited || 0) + (bot.edited || 0))}，删除 ${Number((personal.deleted || 0) + (bot.deleted || 0))}；复用全局连接、Bot offset、统一消息池与来源检查点`);
      setOperation({ kind: "sync", status: "completed", phase: "completed", label: "同步完成，消息列表已刷新", current: selectedSources.size, total: selectedSources.size, resultCount: synced });
      await Promise.all([loadSources(), loadQueue()]);
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "工具内同步失败"));
      setOperation({ kind: "sync", status: "failed", phase: "failed", label: "同步未完成，请按错误提示重试", current: 0, total: 0, resultCount: 0 });
    } finally { setBusy(false); setActivity(""); }
  }

  async function processPayload(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setActivity("process");
    setElapsedSeconds(0);
    setOperation({ kind: "process", status: "running", phase: "preparing", label: "正在准备消息处理", current: 0, total: selectedCount, resultCount: 0 });
    setError(null);
    try {
      const result = await streamTelegramProcess({ tool, ...payload, deleteBody: true }, (progress) => {
        setOperation({ kind: "process", status: progress.phase === "completed" ? "completed" : "running", ...progress });
      });
      setNotice(`${label}：处理 ${result.selected} 条，提取 ${result.resultCount} 条；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立`);
      setOperation({ kind: "process", status: "completed", phase: "completed", label: "处理完成，正在打开结果面板", current: result.selected, total: result.selected, resultCount: result.resultCount });
      resetSelection();
      await loadQueue();
      onProcessed(result);
    } catch (reason) {
      setError(toUiError(reason, "Telegram 消息处理失败"));
      setOperation((current) => ({ kind: "process", status: "failed", phase: "failed", label: "处理未完成，请按错误提示重试", current: current?.current || 0, total: current?.total || selectedCount, resultCount: current?.resultCount || 0 }));
    }
    finally { setBusy(false); setActivity(""); }
  }

  async function processAllPending() {
    if (!selectedSources.size) return;
    if (!window.confirm(`一键处理当前 ${selectedSourceRows.length} 个来源的全部未处理消息？系统会先建立恢复点。`)) return;
    await processPayload({ mode: "all", excludeIds: [], status: "pending", search, start, end, sourceIds: [...selectedSources] }, "全部未处理消息完成");
  }

  async function queueStatus(next: "ignored" | "pending", payload: Record<string, unknown> = selectionPayload) {
    if (!selectedCount && !editRow) return;
    setBusy(true);
    try {
      const result = await api("/api/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "queue-status", tool, ...payload, status: next }) });
      setNotice(`已${next === "ignored" ? "忽略" : "恢复"} ${result.changed} 条；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立`);
      setEditRow(null); resetSelection(); await loadQueue();
    } catch (reason) { setError(toUiError(reason, "队列状态更新失败")); }
    finally { setBusy(false); }
  }

  async function exportChosen(format: "txt" | "csv", copy = false) {
    if (!selectedCount) return;
    try {
      const result = await api("/api/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "export", tool, format, ...selectionPayload }) });
      if (copy) { await navigator.clipboard.writeText(result.content); setNotice(`已复制 ${result.count} 条消息`); }
      else download(`telegram-${tool}.${format}`, result.content, format === "csv" ? "text/csv;charset=utf-8" : undefined);
    } catch (reason) { setError(toUiError(reason, copy ? "复制失败" : "导出失败")); }
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,textarea,select,button")) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") { event.preventDefault(); setSelection({ mode: "all", excluded: new Set() }); }
    else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); void exportChosen("txt", true); }
    else if (event.key === "Delete") { event.preventDefault(); void queueStatus("ignored"); }
    else if (event.key === "Enter" && rows[focused]) { event.preventDefault(); setEditRow(rows[focused]); setEditStatus(rows[focused].status === "ignored" ? "ignored" : "pending"); }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setFocused((value) => Math.max(0, Math.min(rows.length - 1, value + (event.key === "ArrowUp" ? -1 : 1)))); }
  }

  const columns = ["source", "date", "status", "body", "result"];
  const operationElapsed = operation ? elapsedSeconds : 0;
  const operationPercent = operation?.total ? Math.min(100, Math.round((operation.current / operation.total) * 100)) : 0;
  return (
    <div className="telegram-workspace stack-md" tabIndex={0} onKeyDown={keyboard}>
      <section className="callout telegram-layer-callout"><strong>{TOOL_LABELS[tool]}：本次选择</strong><p>这里只选择已绑定来源；登录、Bot offset、消息池和来源检查点仍由全局 Telegram 中心唯一维护。</p></section>
      <section className="card"><div className="section-heading"><div><span className="eyebrow">2 Telegram 消息</span><h3>选择本次要处理的来源</h3></div><button onClick={onOpenTelegramSettings}>管理绑定</button></div>{!sources.length ? <div className="empty compact"><strong>当前工具还没有绑定来源</strong><p>先到全局中心为 {TOOL_LABELS[tool]} 绑定来源。</p><button className="primary" onClick={onOpenTelegramSettings}>打开绑定编辑器</button></div> : <><div className="telegram-source-picker">{sources.map((source) => <label key={source.id} className={selectedSources.has(source.id) ? "selected" : ""}><input type="checkbox" checked={selectedSources.has(source.id)} onChange={() => toggleSource(source.id)} /><span><strong>{source.name}</strong><small>{source.connection_id === "telegram-personal" ? "个人 API" : source.connection_id === "telegram-bot" ? "Bot" : "导入"} · {source.chat_type || "会话"} · {source.external_chat_id}</small></span><small>当前工具已绑定</small></label>)}</div><div className="button-row"><button onClick={() => setSelectedSources(new Set(sources.map((source) => source.id)))}>全选已绑定会话</button><button onClick={() => setSelectedSources(new Set())}>清空本次选择</button></div></>}</section>
      <section className="card"><div className="section-heading"><div><span className="eyebrow">同步与历史回拉</span><h3>{selectedSourceRows.length} 个来源已选择</h3></div><span className="subtle">最多 100 个来源</span></div><div className="telegram-filters"><select value={loadMode} onChange={(event) => setLoadMode(event.target.value as typeof loadMode)}><option value="incremental">从检查点增量</option><option value="recent">回拉最近 N 条</option><option value="range">指定时间范围</option><option value="history">从本地最早处继续</option><option value="cached">只刷新本地消息池</option></select><input type="number" min="1" max="20000" value={syncLimit} onChange={(event) => setSyncLimit(Number(event.target.value) || 200)} /><input type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); setPage(1); }} aria-label="开始时间" /><input type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); setPage(1); }} aria-label="结束时间" /><button className="primary" disabled={busy || !selectedSources.size} onClick={() => void refreshSyncMessages()}>{activity === "sync" ? "同步中…" : "刷新同步消息"}</button></div><p className="subtle">个人账号只读取本次选择；Bot 继续消费唯一全局 getUpdates offset 并进入统一消息池，当前工具视图只显示所选已绑定来源，不会创建第二套登录或游标。</p></section>
      {operation && <section className={`card operation-progress-card ${operation.status}`} aria-live="polite"><div className="operation-progress-heading"><div><span className="eyebrow">{operation.kind === "sync" ? "同步进度" : "处理进度"}</span><h3>{operation.label}</h3></div><span className="operation-progress-percent">{operation.status === "failed" ? "未完成" : operation.total ? `${operationPercent}%` : operation.status === "running" ? "进行中" : "完成"}</span></div><progress max={Math.max(1, operation.total)} value={operation.total ? Math.min(operation.current, operation.total) : undefined} /><div className="operation-progress-metrics"><span>{operation.total ? `${operation.current.toLocaleString()} / ${operation.total.toLocaleString()} ${operation.kind === "process" ? "条消息" : "个来源"}` : `${selectedSources.size.toLocaleString()} 个来源`}</span><span>{operation.kind === "process" ? `已提取 ${operation.resultCount.toLocaleString()} 条结果` : operation.status === "completed" ? `新增 ${operation.resultCount.toLocaleString()} 条消息` : "复用全局连接与检查点"}</span><span>已用时 {operationElapsed} 秒</span></div></section>}
      <section className="data-toolbar card"><div className="searchbox"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); resetSelection(); }} placeholder="搜索消息、来源或消息 ID" /></div><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); resetSelection(); }}><option value="pending">待处理</option><option value="processing">处理中</option><option value="processed">已处理</option><option value="processed_empty">空结果</option><option value="ignored">已忽略</option><option value="error">错误</option><option value="deleted">远端已删除</option><option value="">全部状态</option></select><button onClick={() => setSelection(toggleTablePage(selection, pageIds))}>全选本页</button><button onClick={() => setSelection({ mode: "all", excluded: new Set() })}>全选筛选结果</button><button onClick={() => setColumnsOpen((value) => !value)}>列设置</button><button onClick={() => void loadQueue()}>刷新列表</button></section>
      {columnsOpen && <section className="card result-columns"><strong>显示列</strong>{columns.map((column) => <label key={column}><input type="checkbox" checked={!hidden.has(column)} onChange={(event) => setHidden((current) => { const next = new Set(current); if (event.target.checked) next.delete(column); else next.add(column); return next; })} />{{ source: "来源", date: "时间 / ID", status: "状态", body: "正文", result: "结果" }[column]}</label>)}</section>}
      {selectedCount > 0 && <section className="bulkbar telegram-bulkbar" aria-label="所选 Telegram 消息批量操作"><div className="bulkbar-selection"><span>当前选择</span><strong>{selectedCount.toLocaleString()} 条消息</strong></div><div className="bulkbar-group"><span>处理状态</span><div className="bulkbar-buttons"><button className="primary" disabled={busy} onClick={() => void processPayload(selectionPayload, "所选消息完成")}>{activity === "process" ? "处理中…" : "处理所选"}</button><button disabled={busy} onClick={() => void queueStatus("ignored")}>标为已忽略</button><button disabled={busy} onClick={() => void queueStatus("pending")}>恢复待处理</button></div></div><div className="bulkbar-group"><span>复制 / 导出</span><div className="bulkbar-buttons"><button disabled={busy} onClick={() => void exportChosen("txt", true)}>复制所选消息</button><button disabled={busy} onClick={() => void exportChosen("txt")}>导出 TXT</button><button disabled={busy} onClick={() => void exportChosen("csv")}>导出 CSV</button></div></div><button className="bulkbar-clear" disabled={busy} onClick={resetSelection}>清除选择</button></section>}
      {error && <ErrorNotice error={error} retry={() => void Promise.all([loadSources(), loadQueue()])} />}
      {notice && <div className="notice">{notice}</div>}
      <section className="table-card telegram-table-card">
        <div className="table-meta">
          <span>{total.toLocaleString()} 条可处理消息</span>
          <div className="button-row"><button className="primary" disabled={busy || !selectedSources.size} onClick={() => void processAllPending()}>{activity === "process" ? "处理中…" : "一键处理所有未处理"}</button></div>
        </div>
        <div className="table-scroll desktop-only">
          <table className="sheet">
            <thead><tr><th className="check" onClick={() => setSelection(toggleTablePage(selection, pageIds))}><input readOnly type="checkbox" checked={rows.length > 0 && rows.every((row) => isTableRowSelected(selection, row.id))} /></th>{!hidden.has("source") && <th onClick={() => sortBy("source")}>来源</th>}{!hidden.has("date") && <th onClick={() => sortBy("messageDate")}>时间 / ID</th>}{!hidden.has("status") && <th onClick={() => sortBy("status")}>状态</th>}{!hidden.has("body") && <th>消息正文</th>}{!hidden.has("result") && <th>结果</th>}<th>操作</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={row.id} className={isTableRowSelected(selection, row.id) ? "selected" : ""} onClick={(event) => selectRow(index, event)} onDoubleClick={() => { setEditRow(row); setEditStatus(row.status === "ignored" ? "ignored" : "pending"); }}><td className="check"><input readOnly disabled={row.status === "deleted"} type="checkbox" checked={isTableRowSelected(selection, row.id)} /></td>{!hidden.has("source") && <td><strong>{row.source_name}</strong></td>}{!hidden.has("date") && <td>{formatMessageDate(row.message_date)}<small className="cell-note">#{row.message_id}{row.event_kind === "edited" ? " · 已编辑" : ""}</small></td>}{!hidden.has("status") && <td><span className="status-chip">{queueStatusLabel(row.status)}</span></td>}{!hidden.has("body") && <td className="message-body-cell">{row.body}</td>}{!hidden.has("result") && <td>{row.candidate_count ? `${row.candidate_count} 条` : "—"}</td>}<td><button onClick={(event) => { event.stopPropagation(); setEditRow(row); setEditStatus(row.status === "ignored" ? "ignored" : "pending"); }}>编辑状态</button></td></tr>)}</tbody>
          </table>
        </div>
        <div className="mobile-telegram-list mobile-only">{rows.map((row, index) => <article key={row.id} className={`mobile-table-card ${isTableRowSelected(selection, row.id) ? "selected" : ""}`} onClick={(event) => selectRow(index, event)}><div className="mobile-card-heading"><input readOnly disabled={row.status === "deleted"} type="checkbox" checked={isTableRowSelected(selection, row.id)} /><span className="status-chip">{queueStatusLabel(row.status)}</span><span>{formatMessageDate(row.message_date)}</span></div><strong>{row.source_name} · #{row.message_id}</strong><p>{row.body}</p><small>{row.candidate_count ? `${row.candidate_count} 条结果` : "尚无结果"}</small><button onClick={(event) => { event.stopPropagation(); setEditRow(row); setEditStatus(row.status === "ignored" ? "ignored" : "pending"); }}>编辑状态</button></article>)}</div>
        {!rows.length && <div className="empty compact"><strong>当前筛选没有可处理消息</strong><p>已经处理、正文为空或无法被当前工具识别的内容不会进入工作列表。</p></div>}
        <footer className="pagination"><span>第 {page} / {pages} 页</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); resetSelection(); }}><option value="20">20 / 页</option><option value="50">50 / 页</option><option value="100">100 / 页</option></select><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>
      </section>
      {editRow && <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditRow(null)}><section className="modal-card" role="dialog" aria-modal="true" aria-label="编辑消息队列状态" onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">编辑队列状态</span><h3>{editRow.source_name} · #{editRow.message_id}</h3><select value={editStatus} onChange={(event) => setEditStatus(event.target.value as "pending" | "ignored")}><option value="pending">待处理</option><option value="ignored">已忽略</option></select><div className="button-row"><button className="primary" onClick={() => void queueStatus(editStatus, { mode: "ids", queueIds: [editRow.id] })}>保存并建恢复点</button><button onClick={() => setEditRow(null)}>取消</button></div></section></div>}
    </div>
  );
}

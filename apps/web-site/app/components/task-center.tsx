"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeTaskStatus,
  taskStatusLabel,
  TASK_STATUSES,
  type TaskStatus,
} from "../../lib/task-status";
import {
  isTableRowSelected,
  selectedTableCount,
  toggleTablePage,
  toggleTableRow,
  type TableSelection,
} from "../../lib/table-selection";
import ErrorNotice, { toUiError, type UiError } from "./error-notice";

type Task = {
  id: string;
  tool: string;
  stage: string;
  title: string;
  run_id: string;
  metadata_json: string;
  updated_at: string;
};

type Metrics = {
  total: number;
  success: number;
  empty: number;
  error: number;
  actualSpeed: number;
  etaSeconds: number;
  lastActivityAt: string;
  errorSummary: string;
  errorDetail: string;
};

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function taskMetrics(task: Task): Metrics {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(task.metadata_json || "{}");
  } catch {
    value = {};
  }
  const total = Number(value.total ?? value.resultCount ?? 0) || 0;
  return {
    total,
    success: Number(value.success ?? (normalizeTaskStatus(task.stage) === "completed" ? total : 0)) || 0,
    empty: Number(value.empty ?? value.emptyCount ?? 0) || 0,
    error: Number(value.error ?? value.errorCount ?? 0) || 0,
    actualSpeed: Number(value.actualSpeed ?? value.speed ?? 0) || 0,
    etaSeconds: Number(value.etaSeconds ?? value.eta ?? 0) || 0,
    lastActivityAt: String(value.lastActivityAt || task.updated_at || ""),
    errorSummary: String(value.errorSummary || value.errorMessage || ""),
    errorDetail: String(value.errorDetail || value.technicalDetail || ""),
  };
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function TaskCenter() {
  const [rows, setRows] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [stage, setStage] = useState("");
  const [tool, setTool] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updatedAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selection, setSelection] = useState<TableSelection>({ mode: "ids", ids: new Set() });
  const [focused, setFocused] = useState(0);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [editStatus, setEditStatus] = useState<TaskStatus>("pending");
  const [showMetrics, setShowMetrics] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const anchor = useRef<number | null>(null);
  const filters = useMemo(() => ({ stage, tool, search }), [stage, tool, search]);
  const pageIds = rows.map((row) => row.id);
  const selectedCount = selectedTableCount(selection, total);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async () => {
    const params = new URLSearchParams({ stage, tool, search, sort, direction, page: String(page), pageSize: String(pageSize) });
    try {
      const payload = await api(`/api/tasks?${params}`);
      setRows(payload.rows || []);
      setTotal(Number(payload.total || 0));
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "处理中心读取失败"));
    }
  }, [stage, tool, search, sort, direction, page, pageSize]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 180 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  function resetSelection() {
    setSelection({ mode: "ids", ids: new Set() });
    anchor.current = null;
  }

  function selectionPayload() {
    return selection.mode === "all"
      ? { mode: "all", excludeIds: [...selection.excluded], filters }
      : { mode: "ids", ids: [...selection.ids] };
  }

  async function move(next: TaskStatus, target?: Task) {
    const payload = target ? { mode: "ids", ids: [target.id] } : selectionPayload();
    if (!target && !selectedCount) return;
    try {
      const result = await api("/api/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, stage: next }) });
      setNotice(`已更新 ${Number(result.changed || 0).toLocaleString()} 个任务为“${taskStatusLabel(next)}”${result.snapshotId ? `；恢复点 ${String(result.snapshotId).slice(0, 8)}… 已建立` : ""}`);
      setEditTask(null);
      resetSelection();
      await load();
    } catch (reason) {
      setError(toUiError(reason, "任务状态更新失败"));
    }
  }

  async function cancelSelected() {
    if (!selectedCount) return;
    if (!window.confirm(`确认取消 ${selectedCount.toLocaleString()} 个任务？原始记录和历史不会删除。`)) return;
    await move("cancelled");
  }

  async function exportSelection(format: "txt" | "csv", copy = false) {
    if (!selectedCount) return;
    try {
      const result = await api("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "export", format, ...selectionPayload() }) });
      if (copy) {
        await navigator.clipboard.writeText(result.content);
        setNotice(`已复制 ${Number(result.count || 0).toLocaleString()} 个任务`);
      } else {
        download(`tasks.${format}`, result.content, format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8");
      }
    } catch (reason) {
      setError(toUiError(reason, copy ? "复制失败" : "导出失败"));
    }
  }

  function selectRow(index: number, event: React.MouseEvent) {
    const next = toggleTableRow(selection, pageIds, index, anchor.current, event);
    anchor.current = next.anchor;
    setSelection(next.selection);
    setFocused(index);
  }

  function sortBy(field: string) {
    if (sort === field) setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else { setSort(field); setDirection("asc"); }
    setPage(1);
    resetSelection();
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,select,button,textarea")) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") { event.preventDefault(); setSelection({ mode: "all", excluded: new Set() }); }
    else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); void exportSelection("txt", true); }
    else if (event.key === "Delete") { event.preventDefault(); void cancelSelected(); }
    else if (event.key === "Enter" && rows[focused]) { event.preventDefault(); setEditTask(rows[focused]); setEditStatus(normalizeTaskStatus(rows[focused].stage)); }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setFocused((value) => Math.max(0, Math.min(rows.length - 1, value + (event.key === "ArrowUp" ? -1 : 1)))); }
  }

  return (
    <div className="stack-md" tabIndex={0} onKeyDown={keyboard}>
      <section className="data-toolbar card">
        <div className="searchbox"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); resetSelection(); }} placeholder="搜索任务、批次或来源" /></div>
        <select value={tool} onChange={(event) => { setTool(event.target.value); setPage(1); resetSelection(); }}><option value="">全部工具</option><option value="twitter">Twitter</option><option value="badnews">Bad.news</option><option value="haijiao">海角</option><option value="missav">MissAV</option><option value="av123">123AV</option></select>
        <select value={stage} onChange={(event) => { setStage(event.target.value); setPage(1); resetSelection(); }}><option value="">全部状态</option>{TASK_STATUSES.map((value) => <option key={value} value={value}>{taskStatusLabel(value)}</option>)}</select>
        <button onClick={() => setShowMetrics((value) => !value)}>列设置</button><button onClick={() => void load()}>刷新</button>
      </section>
      {notice && <div className="notice">{notice}</div>}
      {error && <ErrorNotice error={error} retry={() => void load()} />}
      {selectedCount > 0 && <section className="bulkbar"><strong>已选 {selectedCount.toLocaleString()} 个</strong>{selection.mode === "ids" && selectedCount < total && <button onClick={() => setSelection({ mode: "all", excluded: new Set() })}>全选筛选结果 {total.toLocaleString()} 个</button>}<select defaultValue="" onChange={(event) => { if (event.target.value) void move(event.target.value as TaskStatus); event.target.value = ""; }}><option value="">批量改状态…</option>{TASK_STATUSES.map((value) => <option key={value} value={value}>{taskStatusLabel(value)}</option>)}</select><button onClick={() => void exportSelection("txt", true)}>复制</button><button onClick={() => void exportSelection("txt")}>TXT</button><button onClick={() => void exportSelection("csv")}>CSV</button><button className="danger" onClick={() => void cancelSelected()}>取消任务</button><button onClick={resetSelection}>清除选择</button></section>}
      <section className="table-card task-table-card">
        <div className="table-scroll desktop-only"><table className="sheet task-sheet"><thead><tr><th className="check" onClick={() => setSelection(toggleTablePage(selection, pageIds))}><input readOnly type="checkbox" checked={rows.length > 0 && rows.every((row) => isTableRowSelected(selection, row.id))} /></th><th onClick={() => sortBy("tool")}>工具</th><th onClick={() => sortBy("stage")}>状态</th><th onClick={() => sortBy("title")}>任务</th>{showMetrics && <><th>总量 / 成功</th><th>空结果 / 错误</th><th>实际速度 / ETA</th></>}<th onClick={() => sortBy("updatedAt")}>最后活动</th><th>操作</th></tr></thead><tbody>{rows.map((row, index) => { const metrics = taskMetrics(row); const statusValue = normalizeTaskStatus(row.stage); return <tr key={row.id} className={`${isTableRowSelected(selection, row.id) ? "selected" : ""} ${focused === index ? "focused-row" : ""}`} onClick={(event) => selectRow(index, event)} onDoubleClick={() => { setEditTask(row); setEditStatus(statusValue); }}><td className="check"><input readOnly type="checkbox" checked={isTableRowSelected(selection, row.id)} /></td><td><span className={`tool-chip ${row.tool}`}>{row.tool}</span></td><td><span className={`status-chip task-status-${statusValue}`}>{taskStatusLabel(statusValue)}</span>{row.stage !== statusValue && <small className="legacy-status">旧状态：{row.stage}</small>}</td><td className="task-title-cell"><strong>{row.title}</strong>{metrics.errorSummary && <details onClick={(event) => event.stopPropagation()}><summary>{metrics.errorSummary}</summary>{metrics.errorDetail && <pre>{metrics.errorDetail}</pre>}</details>}</td>{showMetrics && <><td>{metrics.total.toLocaleString()} / {metrics.success.toLocaleString()}</td><td>{metrics.empty.toLocaleString()} / {metrics.error.toLocaleString()}</td><td>{metrics.actualSpeed ? `${metrics.actualSpeed.toFixed(1)}/秒` : "—"} / {metrics.etaSeconds ? `${Math.ceil(metrics.etaSeconds / 60)} 分` : "—"}</td></>}<td>{metrics.lastActivityAt ? new Date(metrics.lastActivityAt).toLocaleString("zh-CN") : "—"}</td><td><div className="button-row"><button onClick={(event) => { event.stopPropagation(); setEditTask(row); setEditStatus(statusValue); }}>编辑</button>{["paused", "retry_waiting", "needs_manual", "cancelled"].includes(statusValue) && <button className="primary" onClick={(event) => { event.stopPropagation(); void move("pending", row); }}>恢复</button>}</div></td></tr>; })}</tbody></table></div>
        <div className="mobile-task-list mobile-only">{rows.map((row, index) => { const metrics = taskMetrics(row); const statusValue = normalizeTaskStatus(row.stage); return <article key={row.id} className={`mobile-table-card ${isTableRowSelected(selection, row.id) ? "selected" : ""}`} onClick={(event) => selectRow(index, event)}><div className="mobile-card-heading"><input readOnly type="checkbox" checked={isTableRowSelected(selection, row.id)} /><span className={`tool-chip ${row.tool}`}>{row.tool}</span><span className={`status-chip task-status-${statusValue}`}>{taskStatusLabel(statusValue)}</span></div><strong>{row.title}</strong><dl><div><dt>总量 / 成功</dt><dd>{metrics.total} / {metrics.success}</dd></div><div><dt>空结果 / 错误</dt><dd>{metrics.empty} / {metrics.error}</dd></div><div><dt>速度 / ETA</dt><dd>{metrics.actualSpeed ? `${metrics.actualSpeed.toFixed(1)}/秒` : "—"} / {metrics.etaSeconds ? `${Math.ceil(metrics.etaSeconds / 60)} 分` : "—"}</dd></div><div><dt>最后活动</dt><dd>{new Date(metrics.lastActivityAt || row.updated_at).toLocaleString("zh-CN")}</dd></div></dl>{metrics.errorSummary && <details onClick={(event) => event.stopPropagation()}><summary>{metrics.errorSummary}</summary>{metrics.errorDetail && <pre>{metrics.errorDetail}</pre>}</details>}<div className="button-row"><button onClick={(event) => { event.stopPropagation(); setEditTask(row); setEditStatus(statusValue); }}>编辑状态</button>{["paused", "retry_waiting", "needs_manual", "cancelled"].includes(statusValue) && <button className="primary" onClick={(event) => { event.stopPropagation(); void move("pending", row); }}>恢复</button>}</div></article>; })}</div>
        {!rows.length && <div className="empty compact"><strong>当前筛选没有任务</strong><p>新处理批次会保留在这里；网络错误不会归类为未找到。</p></div>}
        <footer className="pagination"><span>共 {total.toLocaleString()} 个 · 第 {page} / {pages} 页</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); resetSelection(); }}><option value="20">20 / 页</option><option value="50">50 / 页</option><option value="100">100 / 页</option></select><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>
      </section>
      {editTask && <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditTask(null)}><section className="modal-card" role="dialog" aria-modal="true" aria-label="编辑任务状态" onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">任务状态</span><h3>{editTask.title}</h3><select value={editStatus} onChange={(event) => setEditStatus(event.target.value as TaskStatus)}>{TASK_STATUSES.map((value) => <option key={value} value={value}>{taskStatusLabel(value)}</option>)}</select><div className="button-row"><button className="primary" onClick={() => void move(editStatus, editTask)}>保存</button><button onClick={() => setEditTask(null)}>取消</button></div></section></div>}
    </div>
  );
}

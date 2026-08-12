"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolId } from "../../lib/types";
import {
  isTableRowSelected,
  selectedTableCount,
  toggleTablePage,
  toggleTableRow,
  type TableSelection,
} from "../../lib/table-selection";
import ErrorNotice, { toUiError, type UiError } from "./error-notice";

type Run = {
  id: string;
  tool: string;
  name: string;
  result_count: number;
  source_summary: string;
  created_at: string;
};
type Detail = {
  run: Run;
  results: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
};

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function HistoryPanel({ refreshKey, toolId }: { refreshKey: number; toolId?: ToolId }) {
  const [rows, setRows] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState(toolId || "");
  const [sort, setSort] = useState("createdAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selection, setSelection] = useState<TableSelection>({ mode: "ids", ids: new Set() });
  const [focused, setFocused] = useState(0);
  const [showSource, setShowSource] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [renameName, setRenameName] = useState("");
  const anchor = useRef<number | null>(null);
  const filters = useMemo(() => ({ search, tool }), [search, tool]);
  const pageIds = rows.map((row) => row.id);
  const selectedCount = selectedTableCount(selection, total);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const detailPages = Math.max(1, Math.ceil((detail?.total || 0) / 100));

  const load = useCallback(async () => {
    const params = new URLSearchParams({ search, tool, sort, direction, page: String(page), pageSize: String(pageSize) });
    try {
      const payload = await api(`/api/runs?${params}`);
      setRows(payload.rows || []);
      setTotal(Number(payload.total || 0));
      setError(null);
    } catch (reason) {
      setError(toUiError(reason, "历史读取失败"));
    }
  }, [search, tool, sort, direction, page, pageSize]);

  useEffect(() => { const timer = setTimeout(() => void load(), search ? 180 : 0); return () => clearTimeout(timer); }, [load, refreshKey, search]);

  function resetSelection() { setSelection({ mode: "ids", ids: new Set() }); anchor.current = null; }
  function selectionPayload() { return selection.mode === "all" ? { mode: "all", excludeIds: [...selection.excluded], filters } : { mode: "ids", ids: [...selection.ids] }; }

  async function open(id: string, nextPage = 1) {
    try {
      const payload = await api(`/api/runs?id=${encodeURIComponent(id)}&resultPage=${nextPage}&resultPageSize=100`);
      setDetail(payload);
      setDetailPage(nextPage);
      setRenameName(payload.run.name);
      setError(null);
    } catch (reason) { setError(toUiError(reason, "历史详情读取失败")); }
  }

  function selectRow(index: number, event: React.MouseEvent) {
    const next = toggleTableRow(selection, pageIds, index, anchor.current, event);
    anchor.current = next.anchor;
    setSelection(next.selection);
    setFocused(index);
    void open(rows[index].id);
  }

  function sortBy(field: string) { if (sort === field) setDirection((value) => value === "asc" ? "desc" : "asc"); else { setSort(field); setDirection("asc"); } setPage(1); resetSelection(); }

  async function rename() {
    if (!detail || !renameName.trim()) return;
    try {
      await api("/api/runs", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: detail.run.id, name: renameName }) });
      setNotice("历史名称已更新");
      await Promise.all([open(detail.run.id, detailPage), load()]);
    } catch (reason) { setError(toUiError(reason, "历史重命名失败")); }
  }

  async function exportSelection(format: "txt" | "csv" | "json", copy = false) {
    if (!selectedCount) return;
    try {
      const result = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "selection-export", format, ...selectionPayload() }) });
      if (copy) { await navigator.clipboard.writeText(result.content); setNotice(`已复制 ${result.count} 个历史批次`); }
      else download(`history.${format}`, result.content, format === "json" ? "application/json" : format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8");
    } catch (reason) { setError(toUiError(reason, copy ? "历史复制失败" : "历史导出失败")); }
  }

  async function removeSelected() {
    if (!selectedCount) return;
    if (!window.confirm(`删除 ${selectedCount.toLocaleString()} 个历史批次？每个批次都会先建立恢复点，永久记录不会删除。`)) return;
    try {
      const result = await api("/api/runs", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(selectionPayload()) });
      setNotice(`已删除 ${result.deleted} 个历史批次，并建立 ${result.snapshotIds?.length || 0} 个恢复点`);
      if (detail && (selection.mode === "all" || (selection.mode === "ids" && selection.ids.has(detail.run.id)))) setDetail(null);
      resetSelection();
      await load();
    } catch (reason) { setError(toUiError(reason, "历史删除失败")); }
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,select,button,textarea")) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") { event.preventDefault(); setSelection({ mode: "all", excluded: new Set() }); }
    else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); void exportSelection("txt", true); }
    else if (event.key === "Delete") { event.preventDefault(); void removeSelected(); }
    else if (event.key === "Enter" && rows[focused]) { event.preventDefault(); void open(rows[focused].id); }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setFocused((value) => Math.max(0, Math.min(rows.length - 1, value + (event.key === "ArrowUp" ? -1 : 1)))); }
  }

  return <div className="stack-md history-workspace" tabIndex={0} onKeyDown={keyboard}>
    <section className="data-toolbar card"><div className="searchbox"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); resetSelection(); }} placeholder="搜索历史名称" /></div>{!toolId && <select value={tool} onChange={(event) => { setTool(event.target.value); setPage(1); resetSelection(); }}><option value="">全部工具</option><option value="twitter">Twitter</option><option value="badnews">Bad.news</option><option value="haijiao">海角</option><option value="missav">MissAV</option><option value="av123">123AV</option></select>}<button onClick={() => setSelection(toggleTablePage(selection, pageIds))}>全选本页</button><button onClick={() => setSelection({ mode: "all", excluded: new Set() })}>全选筛选结果</button><button onClick={() => setShowSource((value) => !value)}>列设置</button><button onClick={() => void load()}>刷新</button></section>
    {notice && <div className="notice">{notice}</div>}{error && <ErrorNotice error={error} retry={() => void load()} />}
    {selectedCount > 0 && <section className="bulkbar"><strong>已选 {selectedCount.toLocaleString()} 个批次</strong><button onClick={() => void exportSelection("txt", true)}>复制</button><button onClick={() => void exportSelection("txt")}>TXT</button><button onClick={() => void exportSelection("csv")}>CSV</button><button onClick={() => void exportSelection("json")}>JSON</button><button className="danger" onClick={() => void removeSelected()}>删除并建恢复点</button><button onClick={resetSelection}>清除选择</button></section>}
    <section className="table-card history-table-card"><div className="table-scroll desktop-only"><table className="sheet"><thead><tr><th className="check" onClick={() => setSelection(toggleTablePage(selection, pageIds))}><input readOnly type="checkbox" checked={rows.length > 0 && rows.every((row) => isTableRowSelected(selection, row.id))} /></th><th onClick={() => sortBy("tool")}>工具</th><th onClick={() => sortBy("name")}>历史名称</th><th onClick={() => sortBy("resultCount")}>结果量</th>{showSource && <th>来源</th>}<th onClick={() => sortBy("createdAt")}>创建时间</th><th>操作</th></tr></thead><tbody>{rows.map((run, index) => <tr key={run.id} className={`${isTableRowSelected(selection, run.id) ? "selected" : ""} ${detail?.run.id === run.id ? "focused-row" : ""}`} onClick={(event) => selectRow(index, event)}><td className="check"><input readOnly type="checkbox" checked={isTableRowSelected(selection, run.id)} /></td><td><span className={`tool-chip ${run.tool}`}>{run.tool}</span></td><td><strong>{run.name}</strong></td><td>{run.result_count.toLocaleString()}</td>{showSource && <td>{run.source_summary || "—"}</td>}<td>{new Date(run.created_at).toLocaleString("zh-CN")}</td><td><button onClick={(event) => { event.stopPropagation(); void open(run.id); }}>查看 / 编辑</button></td></tr>)}</tbody></table></div><div className="mobile-history-list mobile-only">{rows.map((run, index) => <article key={run.id} className={`mobile-table-card ${isTableRowSelected(selection, run.id) ? "selected" : ""}`} onClick={(event) => selectRow(index, event)}><div className="mobile-card-heading"><input readOnly type="checkbox" checked={isTableRowSelected(selection, run.id)} /><span className={`tool-chip ${run.tool}`}>{run.tool}</span><span>{new Date(run.created_at).toLocaleDateString("zh-CN")}</span></div><strong>{run.name}</strong><p>{run.source_summary || "无来源摘要"}</p><small>{run.result_count.toLocaleString()} 条结果</small><button onClick={(event) => { event.stopPropagation(); void open(run.id); }}>查看 / 编辑</button></article>)}</div>{!rows.length && <div className="empty compact"><strong>暂无历史</strong><p>处理结果保存后会出现在这里。</p></div>}<footer className="pagination"><span>共 {total.toLocaleString()} 个 · 第 {page} / {pages} 页</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); resetSelection(); }}><option value="20">20 / 页</option><option value="30">30 / 页</option><option value="50">50 / 页</option></select><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer></section>
    <section className="card history-detail">{detail ? <><div className="section-heading"><div><span className="eyebrow">历史详情</span><h3>{detail.run.name}</h3></div><button onClick={() => { window.location.href = `/api/export?runId=${detail.run.id}`; }}>导出完整 JSON</button></div><div className="rename-row"><input value={renameName} onChange={(event) => setRenameName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void rename()} /><button onClick={() => void rename()}>保存名称</button></div><dl className="detail-meta"><div><dt>工具</dt><dd>{detail.run.tool}</dd></div><div><dt>结果</dt><dd>{detail.total.toLocaleString()} 条</dd></div><div><dt>来源</dt><dd>{detail.run.source_summary || "—"}</dd></div></dl><div className="detail-results">{detail.results.map((row, index) => <div key={String(row.id)}><span>{(detailPage - 1) * 100 + index + 1}</span><strong>{String(row.primary_value)}</strong><small>{String(row.secondary_value || row.source || "")}</small></div>)}</div><footer className="pagination"><span>结果第 {detailPage} / {detailPages} 页</span><button disabled={detailPage <= 1} onClick={() => void open(detail.run.id, detailPage - 1)}>上一页</button><button disabled={detailPage >= detailPages} onClick={() => void open(detail.run.id, detailPage + 1)}>下一页</button></footer></> : <div className="empty compact"><strong>选择一条历史查看详情</strong><p>单击替换选择，Ctrl 切换，Shift 连选；Ctrl+A/C、方向键、Enter 和 Delete 可用。</p></div>}</section>
  </div>;
}

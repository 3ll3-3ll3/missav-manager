"use client";

import { useMemo, useRef, useState } from "react";
import { csvSafe } from "../../lib/security";
import type { ToolResult } from "../../lib/types";
import { toggleTableRow } from "../../lib/table-selection";

type Column = "primaryValue" | "secondaryValue" | "status" | "tags" | "source";
const COLUMNS: Array<{ key: Column; label: string }> = [
  { key: "primaryValue", label: "主值" },
  { key: "secondaryValue", label: "辅助值" },
  { key: "status", label: "状态" },
  { key: "tags", label: "标签" },
  { key: "source", label: "来源" },
];

function value(row: ToolResult, key: Column) {
  const current = row[key];
  return Array.isArray(current) ? current.join(" | ") : String(current || "");
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function ResultTable({
  tool,
  results,
  setResults,
  selected,
  setSelected,
  notice,
}: {
  tool: string;
  results: ToolResult[];
  setResults: React.Dispatch<React.SetStateAction<ToolResult[]>>;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  notice: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<Column>("primaryValue");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [hidden, setHidden] = useState<Set<Column>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [focused, setFocused] = useState({ row: 0, col: 0 });
  const [editing, setEditing] = useState<ToolResult | null>(null);
  const [editPrimary, setEditPrimary] = useState("");
  const [editSecondary, setEditSecondary] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editTags, setEditTags] = useState("");
  const anchor = useRef<number | null>(null);
  const visibleColumns = COLUMNS.filter((column) => !hidden.has(column.key));
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return results
      .filter((row) => !status || String(row.status || "") === status)
      .filter((row) => !query || COLUMNS.some((column) => value(row, column.key).toLowerCase().includes(query)))
      .sort((left, right) => value(left, sort).localeCompare(value(right, sort), "zh-CN") * (direction === "asc" ? 1 : -1));
  }, [results, search, status, sort, direction]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const pageIds = pageRows.map((row) => row.resultKey);
  const chosen = results.filter((row) => selected.has(row.resultKey));
  const statuses = [...new Set(results.map((row) => String(row.status || "success")))];

  function rowSelect(index: number, event: React.MouseEvent) {
    const next = toggleTableRow({ mode: "ids", ids: selected }, pageIds, index, anchor.current, event);
    anchor.current = next.anchor;
    if (next.selection.mode === "ids") setSelected(next.selection.ids);
    setFocused((current) => ({ ...current, row: index }));
  }

  function sortBy(key: Column) {
    if (sort === key) setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else { setSort(key); setDirection("asc"); }
    setPage(1);
  }

  function selectPage() {
    setSelected((current) => {
      const next = new Set(current);
      const every = pageIds.length > 0 && pageIds.every((id) => next.has(id));
      for (const id of pageIds) {
        if (every) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function openEdit(row: ToolResult) {
    setEditing(row);
    setEditPrimary(row.primaryValue);
    setEditSecondary(row.secondaryValue || "");
    setEditStatus(row.status || "success");
    setEditTags((row.tags || []).join("\n"));
  }

  function saveEdit() {
    if (!editing || !editPrimary.trim()) return;
    setResults((current) => current.map((row) => row.resultKey === editing.resultKey ? { ...row, primaryValue: editPrimary.trim(), secondaryValue: editSecondary.trim(), status: editStatus.trim() || "success", tags: editTags.split(/\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean) } : row));
    setEditing(null);
    notice("草稿结果已编辑；保存历史时会持久化");
  }

  function removeSelected() {
    if (!selected.size) return;
    if (!window.confirm(`从本次未保存草稿移除 ${selected.size} 条结果？`)) return;
    setResults((current) => current.filter((row) => !selected.has(row.resultKey)));
    setSelected(new Set());
    notice("已从本次未保存草稿移除所选结果");
  }

  function text(rows: ToolResult[]) {
    return rows.map((row) => [row.primaryValue, row.secondaryValue || "", row.status || "", (row.tags || []).join("|")].join("\t")).join("\r\n");
  }

  async function copy() {
    if (!chosen.length) return;
    await navigator.clipboard.writeText(text(chosen));
    notice(`已复制 ${chosen.length.toLocaleString()} 条结果`);
  }

  function exportRows(format: "txt" | "csv") {
    if (!chosen.length) return;
    const content = format === "txt" ? text(chosen) : `\uFEFF${[["primary", "secondary", "status", "tags", "source"].map(csvSafe).join(","), ...chosen.map((row) => [row.primaryValue, row.secondaryValue, row.status, (row.tags || []).join("|"), row.source].map(csvSafe).join(","))].join("\r\n")}`;
    download(`${tool}-results.${format}`, content, format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8");
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,textarea,select,button")) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(new Set(filtered.map((row) => row.resultKey))); }
    else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); void copy(); }
    else if (event.key === "Delete") { event.preventDefault(); removeSelected(); }
    else if (event.key === "Enter" && pageRows[focused.row]) { event.preventDefault(); openEdit(pageRows[focused.row]); }
    else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      setFocused((current) => ({
        row: Math.max(0, Math.min(pageRows.length - 1, current.row + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0))),
        col: Math.max(0, Math.min(visibleColumns.length - 1, current.col + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0))),
      }));
    }
  }

  return (
    <div className="stack-md result-table-workspace" tabIndex={0} onKeyDown={keyboard}>
      <section className="data-toolbar card"><div className="searchbox"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); setSelected(new Set()); }} placeholder="搜索主值、链接、状态或标签" /></div><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); setSelected(new Set()); }}><option value="">全部状态</option>{statuses.map((item) => <option key={item}>{item}</option>)}</select><button onClick={selectPage}>全选本页</button><button onClick={() => setSelected(new Set(filtered.map((row) => row.resultKey)))}>全选筛选结果</button><button onClick={() => setColumnsOpen((value) => !value)}>列设置</button></section>
      {columnsOpen && <section className="card result-columns"><strong>显示列</strong>{COLUMNS.map((column) => <label key={column.key}><input type="checkbox" checked={!hidden.has(column.key)} onChange={(event) => setHidden((current) => { const next = new Set(current); if (event.target.checked) next.delete(column.key); else next.add(column.key); return next; })} />{column.label}</label>)}</section>}
      {selected.size > 0 && <section className="bulkbar"><strong>已选 {selected.size.toLocaleString()} 条</strong><button onClick={() => void copy()}>复制</button><button onClick={() => exportRows("txt")}>TXT</button><button onClick={() => exportRows("csv")}>CSV</button><button onClick={() => openEdit(chosen[0])}>编辑首条</button><button className="danger" onClick={removeSelected}>删除草稿行</button><button onClick={() => setSelected(new Set())}>清除选择</button></section>}
      <section className="table-card result-sheet-card">
        <div className="table-scroll desktop-only"><table className="sheet"><thead><tr><th className="check" onClick={selectPage}><input readOnly type="checkbox" checked={pageIds.length > 0 && pageIds.every((id) => selected.has(id))} /></th><th>#</th>{visibleColumns.map((column) => <th key={column.key} onClick={() => sortBy(column.key)}>{column.label}{sort === column.key ? direction === "asc" ? " ↑" : " ↓" : ""}</th>)}</tr></thead><tbody>{pageRows.map((row, index) => <tr key={row.resultKey} className={selected.has(row.resultKey) ? "selected" : ""} onClick={(event) => rowSelect(index, event)} onDoubleClick={() => openEdit(row)}><td className="check"><input readOnly type="checkbox" checked={selected.has(row.resultKey)} /></td><td>{(page - 1) * pageSize + index + 1}</td>{visibleColumns.map((column, columnIndex) => <td key={column.key} className={focused.row === index && focused.col === columnIndex ? "focused-cell" : ""}>{value(row, column.key) || "—"}</td>)}</tr>)}</tbody></table></div>
        <div className="mobile-result-cards mobile-only">{pageRows.map((row, index) => <article key={row.resultKey} className={`mobile-table-card ${selected.has(row.resultKey) ? "selected" : ""}`} onClick={(event) => rowSelect(index, event)}><div className="mobile-card-heading"><input readOnly type="checkbox" checked={selected.has(row.resultKey)} /><span className="row-index">{(page - 1) * pageSize + index + 1}</span><span className="status-chip">{row.status || "success"}</span></div><strong>{row.primaryValue}</strong><p>{row.secondaryValue || row.source || "—"}</p><small>{(row.tags || []).join(" · ") || "无标签"}</small><button onClick={(event) => { event.stopPropagation(); openEdit(row); }}>编辑</button></article>)}</div>
        {!pageRows.length && <div className="empty compact"><strong>当前筛选没有结果</strong><p>回到“1 输入”运行规则，或调整搜索和状态筛选。</p></div>}
        <footer className="pagination"><span>筛选 {filtered.length.toLocaleString()} / 全部 {results.length.toLocaleString()} 条 · 第 {page} / {pages} 页</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="20">20 / 页</option><option value="50">50 / 页</option><option value="100">100 / 页</option></select><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>
      </section>
      {editing && <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditing(null)}><section className="modal-card" role="dialog" aria-modal="true" aria-label="编辑结果" onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">编辑结果</span><label className="field"><span>主值</span><input value={editPrimary} onChange={(event) => setEditPrimary(event.target.value)} /></label><label className="field"><span>辅助值</span><textarea rows={3} value={editSecondary} onChange={(event) => setEditSecondary(event.target.value)} /></label><label className="field"><span>状态</span><input value={editStatus} onChange={(event) => setEditStatus(event.target.value)} /></label><label className="field"><span>标签（一行一个）</span><textarea rows={5} value={editTags} onChange={(event) => setEditTags(event.target.value)} /></label><div className="button-row"><button className="primary" onClick={saveEdit}>保存草稿</button><button onClick={() => setEditing(null)}>取消</button></div></section></div>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseCsvRows } from "../../lib/rules";
import { validateMigrationRecord } from "../../lib/migration";
import { sha256Hex } from "../../lib/security";
import type { RecordRow, ToolId } from "../../lib/types";

type Listing = {
  rows: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
};
type Selection =
  | { mode: "ids"; ids: Set<string> }
  | { mode: "all"; excluded: Set<string> };
type Column = {
  key: keyof RecordRow;
  label: string;
  editable?: boolean;
  width: number;
};
type EditState = {
  row: RecordRow;
  field: string;
  value: string;
  isList: boolean;
} | null;
type TablePreferences = {
  order: string[];
  hidden: Set<string>;
  widths: Record<string, number>;
};
const baseColumns: Column[] = [
  { key: "tool", label: "工具", width: 100 },
  { key: "primaryValue", label: "主值", editable: true, width: 180 },
  { key: "secondaryValue", label: "辅助值", editable: true, width: 220 },
  { key: "status", label: "状态", editable: true, width: 110 },
  { key: "tags", label: "标签", editable: true, width: 180 },
  { key: "actressTags", label: "女优标签", editable: true, width: 180 },
  { key: "genreTags", label: "类型标签", editable: true, width: 160 },
  { key: "sourceUrl", label: "来源链接", editable: true, width: 120 },
  { key: "missavUrl", label: "MissAV 链接", editable: true, width: 130 },
  { key: "av123Url", label: "123AV 链接", editable: true, width: 130 },
  { key: "updatedAt", label: "更新时间", width: 170 },
];
const fieldLabels = Object.fromEntries(
  baseColumns.map((column) => [column.key, column.label]),
);
async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
function selectionBody(selection: Selection, filters: Record<string, string>) {
  return selection.mode === "all"
    ? { mode: "all", excludeIds: [...selection.excluded], filters }
    : { mode: "ids", ids: [...selection.ids] };
}
function cell(row: RecordRow, field: string): unknown {
  return row[field as keyof RecordRow];
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
function tablePreferences(): TablePreferences {
  const fallback = {
    order: baseColumns.map((column) => String(column.key)),
    hidden: new Set<string>(),
    widths: Object.fromEntries(
      baseColumns.map((column) => [column.key, column.width]),
    ),
  };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(
      localStorage.getItem("missav-table-columns-v1") || "null",
    );
    return {
      order: Array.isArray(saved?.order) ? saved.order : fallback.order,
      hidden: new Set<string>(Array.isArray(saved?.hidden) ? saved.hidden : []),
      widths:
        saved?.widths && typeof saved.widths === "object"
          ? saved.widths
          : fallback.widths,
    };
  } catch {
    return fallback;
  }
}

export default function DataCenter({ refreshKey }: { refreshKey: number }) {
  const [prefs] = useState(tablePreferences);
  const [data, setData] = useState<Listing>({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("updatedAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selection, setSelection] = useState<Selection>({
    mode: "ids",
    ids: new Set(),
  });
  const [bulkField, setBulkField] = useState("status");
  const [bulkValue, setBulkValue] = useState("");
  const [editState, setEditState] = useState<EditState>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addTool, setAddTool] = useState<ToolId>("missav");
  const [addValue, setAddValue] = useState("");
  const [columnOrder, setColumnOrder] = useState(prefs.order);
  const [hidden, setHidden] = useState<Set<string>>(prefs.hidden);
  const [widths, setWidths] = useState<Record<string, number>>(prefs.widths);
  const [columnMenu, setColumnMenu] = useState(false);
  const [focused, setFocused] = useState({ row: 0, col: 0 });
  const [findValue, setFindValue] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [replaceField, setReplaceField] = useState("primaryValue");
  const lastIndex = useRef<number | null>(null);
  const filters = useMemo(
    () => ({ search, tool, status, sort, direction }),
    [search, tool, status, sort, direction],
  );
  const columns = useMemo(
    () =>
      columnOrder.flatMap((key) => {
        const column = baseColumns.find((item) => item.key === key);
        return column && !hidden.has(String(column.key)) ? [column] : [];
      }),
    [columnOrder, hidden],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...filters,
      });
      setData(await api(`/api/records?${params}`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filters]);
  useEffect(() => {
    const timeout = setTimeout(load, search ? 260 : 0);
    return () => clearTimeout(timeout);
  }, [load, refreshKey, search]);
  useEffect(() => {
    localStorage.setItem(
      "missav-table-columns-v1",
      JSON.stringify({ order: columnOrder, hidden: [...hidden], widths }),
    );
  }, [columnOrder, hidden, widths]);
  const selectedCount =
    selection.mode === "all"
      ? Math.max(0, data.total - selection.excluded.size)
      : selection.ids.size;
  const isSelected = (id: string) =>
    selection.mode === "all"
      ? !selection.excluded.has(id)
      : selection.ids.has(id);
  function resetSelection() {
    setSelection({ mode: "ids", ids: new Set() });
    lastIndex.current = null;
  }
  function toggleRow(index: number, event: React.MouseEvent) {
    const id = data.rows[index].id;
    if (selection.mode === "all") {
      const excluded = new Set(selection.excluded);
      if (excluded.has(id)) excluded.delete(id);
      else excluded.add(id);
      setSelection({ mode: "all", excluded });
      return;
    }
    const ids = new Set(selection.ids);
    if (event.shiftKey && lastIndex.current !== null) {
      const [from, to] = [lastIndex.current, index].sort((a, b) => a - b);
      if (!event.ctrlKey && !event.metaKey) ids.clear();
      for (let i = from; i <= to; i += 1) ids.add(data.rows[i].id);
    } else if (event.ctrlKey || event.metaKey) {
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
    } else {
      ids.clear();
      ids.add(id);
    }
    lastIndex.current = index;
    setFocused((current) => ({ ...current, row: index }));
    setSelection({ mode: "ids", ids });
  }
  function togglePage() {
    const every =
      data.rows.length > 0 && data.rows.every((row) => isSelected(row.id));
    if (selection.mode === "all") {
      const excluded = new Set(selection.excluded);
      data.rows.forEach((row) =>
        every ? excluded.add(row.id) : excluded.delete(row.id),
      );
      setSelection({ mode: "all", excluded });
    } else {
      const ids = new Set(selection.ids);
      data.rows.forEach((row) =>
        every ? ids.delete(row.id) : ids.add(row.id),
      );
      setSelection({ mode: "ids", ids });
    }
  }
  function sortBy(field: string) {
    if (sort === field)
      setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSort(field);
      setDirection("asc");
    }
    setPage(1);
  }
  function openEdit(row: RecordRow, field: string) {
    const original = cell(row, field);
    setEditState({
      row,
      field,
      value: Array.isArray(original)
        ? original.join("\n")
        : String(original ?? ""),
      isList: Array.isArray(original),
    });
  }
  async function saveEdit() {
    if (!editState) return;
    const value = editState.isList
      ? editState.value
          .split(/\r?\n|[,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : editState.value;
    try {
      await api("/api/records", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editState.row.id,
          field: editState.field,
          value,
        }),
      });
      setNotice("单元格已保存，并已建立恢复点");
      setEditState(null);
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    }
  }
  async function bulk(action: "update" | "delete") {
    if (!selectedCount) return;
    if (
      action === "delete" &&
      !window.confirm(
        `确认删除 ${selectedCount.toLocaleString()} 条记录？系统会先创建可恢复快照。`,
      )
    )
      return;
    try {
      const payload = {
        ...selectionBody(selection, filters),
        ...(action === "update"
          ? {
              action: "bulk-update",
              field: bulkField,
              value: ["tags", "actressTags", "genreTags"].includes(bulkField)
                ? bulkValue
                    .split(/\r?\n|[,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean)
                : bulkValue,
            }
          : {}),
      };
      const result = await api("/api/records", {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setNotice(
        `${action === "delete" ? "删除" : "修改"} ${result.changed.toLocaleString()} 条；恢复点已保存`,
      );
      resetSelection();
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    }
  }
  async function add() {
    if (!addValue.trim()) return;
    try {
      await api("/api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: addTool,
          recordKey: addValue.trim().toLowerCase(),
          primaryValue: addValue.trim(),
          status: "manual",
        }),
      });
      setNotice("记录已新增");
      setAddOpen(false);
      setAddValue("");
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "新增失败");
    }
  }
  async function selectionContent(format: "csv" | "json" | "txt" | "tsv") {
    return (
      await api("/api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "selection-export",
          format,
          ...selectionBody(
            selectedCount ? selection : { mode: "all", excluded: new Set() },
            filters,
          ),
        }),
      })
    ).content as string;
  }
  async function copy() {
    try {
      const content = await selectionContent("tsv");
      await navigator.clipboard.writeText(content);
      setNotice(`已跨页复制 ${selectedCount || data.total} 条 TSV`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "复制失败");
    }
  }
  async function exportSelection(format: "csv" | "json" | "txt") {
    try {
      const content = await selectionContent(format);
      download(
        `missav-manager-selected.${format}`,
        content,
        format === "json" ? "application/json" : "text/plain;charset=utf-8",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出失败");
    }
  }
  function exportRaindrop(format: "csv" | "html") {
    const params = new URLSearchParams({ format, search, status });
    window.location.href = `/api/raindrop?${params}`;
  }
  async function replaceSelected() {
    if (!selectedCount || !findValue) return;
    try {
      const result = await api("/api/records", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "replace",
          field: replaceField,
          find: findValue,
          replace: replaceValue,
          ...selectionBody(selection, filters),
        }),
      });
      setNotice(`查找替换完成：修改 ${result.changed} 条，并已建立恢复点`);
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "替换失败");
    }
  }
  async function paste(event: React.ClipboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,textarea,select")) return;
    if (!data.rows[focused.row]) return;
    const values = event.clipboardData
      .getData("text/plain")
      .split(/\r?\n/)[0]
      .split("\t");
    if (values.length < 1) return;
    event.preventDefault();
    const editable = columns
      .slice(focused.col)
      .filter((column) => column.editable);
    const changes: Record<string, unknown> = {};
    values.forEach((value, index) => {
      const column = editable[index];
      if (!column) return;
      changes[column.key] = ["tags", "actressTags", "genreTags"].includes(
        String(column.key),
      )
        ? value.split("|").filter(Boolean)
        : value;
    });
    try {
      await api("/api/records", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "paste",
          id: data.rows[focused.row].id,
          values: changes,
        }),
      });
      setNotice("已粘贴表格区域，并已建立恢复点");
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "粘贴失败");
    }
  }
  async function importCsv(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("CSV 超过 50 MB");
      const rows = parseCsvRows(await file.text());
      if (rows.length < 2) throw new Error("CSV 没有数据行");
      const headers = rows[0];
      const raw = rows
        .slice(1)
        .map((values) =>
          Object.fromEntries(
            headers.map((header, index) => [header, values[index] ?? ""]),
          ),
        );
      const checked = raw.map(validateMigrationRecord);
      const records = checked.flatMap((item) =>
        item.record ? [item.record] : [],
      );
      const rejected = checked.filter((item) => !item.record);
      if (!records.length) throw new Error("CSV 没有可导入记录");
      if (
        !window.confirm(
          `数据中心 CSV：可导入 ${records.length} 条，拒绝 ${rejected.length} 条。确认后按迁移批次写入？`,
        )
      )
        return;
      const started = await api("/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start",
          fileName: file.name,
          totalRows: raw.length,
          validRows: records.length,
          rejectedRows: rejected.length,
          counts: {},
          strategy: "skip_conflicts",
        }),
      });
      const chunks = [];
      for (let offset = 0; offset < records.length; offset += 40)
        chunks.push(records.slice(offset, offset + 40));
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        await api("/api/migrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "append",
            batchId: started.batchId,
            chunkIndex: index,
            chunkChecksum: await sha256Hex(JSON.stringify(chunk)),
            records: chunk,
          }),
        });
      }
      await api("/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          batchId: started.batchId,
          expectedChunks: chunks.length,
          expectedRows: records.length,
        }),
      });
      setNotice(`CSV 已导入 ${records.length} 条；${rejected.length} 条被拒绝`);
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "CSV 导入失败");
    }
  }
  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,textarea,select,button"))
      return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection({ mode: "all", excluded: new Set() });
      return;
    }
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copy();
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      bulk("delete");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = data.rows[focused.row];
      const column = columns[focused.col];
      if (row && column?.editable) openEdit(row, String(column.key));
      return;
    }
    const move: { [key: string]: [number, number] } = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (move[event.key]) {
      event.preventDefault();
      const [dr, dc] = move[event.key];
      setFocused((current) => ({
        row: Math.max(0, Math.min(data.rows.length - 1, current.row + dr)),
        col: Math.max(0, Math.min(columns.length - 1, current.col + dc)),
      }));
    }
  }
  function resizeStart(key: string, event: React.MouseEvent) {
    event.preventDefault();
    const start = event.clientX;
    const original = widths[key] || 140;
    const move = (moveEvent: MouseEvent) =>
      setWidths((current) => ({
        ...current,
        [key]: Math.max(70, original + moveEvent.clientX - start),
      }));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }
  function moveColumn(key: string, directionValue: number) {
    setColumnOrder((current) => {
      const next = [...current];
      const index = next.indexOf(key);
      const target = Math.max(
        0,
        Math.min(next.length - 1, index + directionValue),
      );
      next.splice(index, 1);
      next.splice(target, 0, key);
      return next;
    });
  }
  const pages = Math.max(1, Math.ceil(data.total / pageSize));
  return (
    <div className="stack-md" tabIndex={0} onKeyDown={keyboard} onPaste={paste}>
      <section className="data-toolbar card">
        <div className="searchbox">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
              resetSelection();
            }}
            placeholder="搜索番号、链接、标签或状态…"
          />
        </div>
        <select
          value={tool}
          onChange={(event) => {
            setTool(event.target.value);
            setPage(1);
            resetSelection();
          }}
        >
          <option value="">全部工具</option>
          {["twitter", "badnews", "haijiao", "missav", "av123"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          className="status-filter"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
            resetSelection();
          }}
          placeholder="状态筛选"
        />
        <button onClick={() => setAddOpen(true)}>＋ 新增</button>
        <label className="file-button compact">
          <input type="file" accept=".csv" onChange={importCsv} />
          导入 CSV
        </label>
        <button onClick={() => exportSelection("csv")}>CSV</button>
        <button onClick={() => exportSelection("txt")}>TXT</button>
        <button onClick={() => exportSelection("json")}>JSON</button>
        <button onClick={() => setColumnMenu((value) => !value)}>列设置</button>
        <button onClick={() => exportRaindrop("csv")}>Raindrop CSV</button>
        <button onClick={() => exportRaindrop("html")}>书签 HTML</button>
      </section>
      {columnMenu && (
        <section className="column-settings card">
          {columnOrder.map((key) => {
            const column = baseColumns.find((item) => item.key === key)!;
            return (
              <div key={key}>
                <input
                  type="checkbox"
                  checked={!hidden.has(key)}
                  onChange={(event) =>
                    setHidden((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
                <span>{column.label}</span>
                <button onClick={() => moveColumn(key, -1)}>↑</button>
                <button onClick={() => moveColumn(key, 1)}>↓</button>
                <input
                  type="number"
                  min="70"
                  max="500"
                  value={widths[key] || column.width}
                  onChange={(event) =>
                    setWidths((current) => ({
                      ...current,
                      [key]: Number(event.target.value),
                    }))
                  }
                />
              </div>
            );
          })}
        </section>
      )}
      {notice && <div className="notice">{notice}</div>}
      {selectedCount > 0 && (
        <>
          <section className="bulkbar">
            <strong>已选 {selectedCount.toLocaleString()} 条</strong>
            {selection.mode === "ids" && selectedCount < data.total && (
              <button
                onClick={() =>
                  setSelection({ mode: "all", excluded: new Set() })
                }
              >
                选择全部筛选结果 {data.total.toLocaleString()} 条
              </button>
            )}
            <select
              value={bulkField}
              onChange={(event) => setBulkField(event.target.value)}
            >
              {baseColumns
                .filter((column) => column.editable)
                .map((column) => (
                  <option value={column.key} key={column.key}>
                    {column.label}
                  </option>
                ))}
            </select>
            <input
              value={bulkValue}
              onChange={(event) => setBulkValue(event.target.value)}
              placeholder="批量新值"
            />
            <button onClick={() => bulk("update")}>批量修改</button>
            <button onClick={copy}>跨页复制 TSV</button>
            <button className="danger" onClick={() => bulk("delete")}>
              删除
            </button>
            <button onClick={resetSelection}>取消</button>
          </section>
          <section className="replace-bar card">
            <select
              value={replaceField}
              onChange={(event) => setReplaceField(event.target.value)}
            >
              {baseColumns
                .filter(
                  (column) =>
                    column.editable &&
                    !["tags", "actressTags", "genreTags"].includes(
                      String(column.key),
                    ),
                )
                .map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
            </select>
            <input
              value={findValue}
              onChange={(event) => setFindValue(event.target.value)}
              placeholder="查找"
            />
            <input
              value={replaceValue}
              onChange={(event) => setReplaceValue(event.target.value)}
              placeholder="替换为"
            />
            <button onClick={replaceSelected}>对所选查找替换</button>
          </section>
        </>
      )}
      <section className="table-card">
        <div className="table-meta">
          <span>
            {loading
              ? "读取中…"
              : `共 ${data.total.toLocaleString()} 条 · 服务端分页`}
          </span>
          <span>
            Ctrl+A 全选筛选结果 · Ctrl+C 跨页复制 · 方向键 / Enter / Delete /
            粘贴
          </span>
        </div>
        <div className="table-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th className="check">
                  <input
                    type="checkbox"
                    checked={
                      data.rows.length > 0 &&
                      data.rows.every((row) => isSelected(row.id))
                    }
                    onChange={togglePage}
                  />
                </th>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    style={{
                      width: widths[column.key],
                      minWidth: widths[column.key],
                    }}
                    onClick={() =>
                      ["tool", "primaryValue", "status", "updatedAt"].includes(
                        String(column.key),
                      ) && sortBy(String(column.key))
                    }
                  >
                    {column.label}
                    {sort === column.key && (direction === "asc" ? " ↑" : " ↓")}
                    <span
                      className="resize-handle"
                      onMouseDown={(event) =>
                        resizeStart(String(column.key), event)
                      }
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, rowIndex) => (
                <tr
                  key={row.id}
                  className={isSelected(row.id) ? "selected" : ""}
                  onClick={(event) => toggleRow(rowIndex, event)}
                >
                  <td className="check">
                    <input
                      type="checkbox"
                      readOnly
                      checked={isSelected(row.id)}
                    />
                  </td>
                  {columns.map((column, colIndex) => {
                    const value = cell(row, String(column.key));
                    const focusedCell =
                      focused.row === rowIndex && focused.col === colIndex;
                    return (
                      <td
                        key={column.key}
                        className={focusedCell ? "focused-cell" : ""}
                        onClick={() =>
                          setFocused({ row: rowIndex, col: colIndex })
                        }
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          if (column.editable)
                            openEdit(row, String(column.key));
                        }}
                      >
                        {column.key === "tool" ? (
                          <span className={`tool-chip ${row.tool}`}>
                            {row.tool}
                          </span>
                        ) : column.key === "status" ? (
                          <span className="status-chip">{row.status}</span>
                        ) : column.key === "updatedAt" ? (
                          new Date(row.updatedAt).toLocaleString("zh-CN")
                        ) : String(column.key).toLowerCase().includes("url") &&
                          value ? (
                          <a
                            href={String(value)}
                            onClick={(event) => event.stopPropagation()}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开 ↗
                          </a>
                        ) : Array.isArray(value) ? (
                          value.join(" · ") || "—"
                        ) : (
                          String(value || "—")
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!loading && !data.rows.length && (
                <tr>
                  <td colSpan={columns.length + 1}>
                    <div className="empty compact">
                      <strong>没有符合条件的记录</strong>
                      <p>先运行内容处理，或导入一份脱敏数据。</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="pagination">
          <label>
            每页{" "}
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              <option>20</option>
              <option>50</option>
              <option>100</option>
              <option>200</option>
            </select>
          </label>
          <span>
            第 {page} / {pages} 页
          </span>
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
      {editState && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setEditState(null)
          }
        >
          <section className="modal-card">
            <span className="eyebrow">长文本编辑器</span>
            <h3>编辑 {fieldLabels[editState.field] || editState.field}</h3>
            <textarea
              autoFocus
              rows={14}
              value={editState.value}
              onChange={(event) =>
                setEditState((current) =>
                  current ? { ...current, value: event.target.value } : null,
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditState(null);
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
                  saveEdit();
              }}
            />
            <div className="button-row">
              <button onClick={() => setEditState(null)}>取消</button>
              <button className="primary" onClick={saveEdit}>
                保存并建立恢复点
              </button>
            </div>
          </section>
        </div>
      )}
      {addOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setAddOpen(false)
          }
        >
          <section className="modal-card">
            <span className="eyebrow">新增业务记录</span>
            <h3>选择工具并填写主值</h3>
            <select
              value={addTool}
              onChange={(event) => setAddTool(event.target.value as ToolId)}
            >
              {["twitter", "badnews", "haijiao", "missav", "av123"].map(
                (value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ),
              )}
            </select>
            <input
              autoFocus
              value={addValue}
              onChange={(event) => setAddValue(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && add()}
              placeholder="番号、用户名或规范链接"
            />
            <div className="button-row">
              <button onClick={() => setAddOpen(false)}>取消</button>
              <button className="primary" onClick={add}>
                新增
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

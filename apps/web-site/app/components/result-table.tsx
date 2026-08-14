"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { csvSafe } from "../../lib/security";
import type { ToolResult } from "../../lib/types";
import { toggleTableRow } from "../../lib/table-selection";

type Column =
  | "primaryValue"
  | "secondaryValue"
  | "status"
  | "tags"
  | "error"
  | "source"
  | "messageId"
  | "messageDate"
  | "originalValue";
const COLUMNS: Array<{ key: Column; label: string }> = [
  { key: "primaryValue", label: "主值" },
  { key: "secondaryValue", label: "辅助值" },
  { key: "status", label: "状态" },
  { key: "tags", label: "标签" },
  { key: "error", label: "错误 / 备注" },
  { key: "source", label: "来源" },
  { key: "messageId", label: "消息 ID" },
  { key: "messageDate", label: "消息时间" },
  { key: "originalValue", label: "原始候选" },
];

function statusLabel(value: unknown) {
  const status = String(value || "success");
  return (
    (
      {
        success: "成功",
        succeeded: "成功",
        pending: "待生成 / 执行浏览器脚本",
        task_ready: "待本地处理",
        result_imported: "已导入结果",
        not_found: "未找到",
        network_error: "网络异常",
        verify_required: "待核验",
        error: "异常",
      } as Record<string, string>
    )[status] || status
  );
}

function value(row: ToolResult, key: Column) {
  if (key === "status") return statusLabel(row.status);
  if (key === "error") return String(row.error || row.remark || "");
  if (key === "messageId" || key === "messageDate" || key === "originalValue")
    return String(row.metadata?.[key] || "");
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
  onFilteredChange,
}: {
  tool: string;
  results: ToolResult[];
  setResults: React.Dispatch<React.SetStateAction<ToolResult[]>>;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  notice: (message: string) => void;
  onFilteredChange?: (rows: ToolResult[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<Column>("primaryValue");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [hidden, setHidden] = useState<Set<Column>>(new Set());
  const [columnOrder, setColumnOrder] = useState<Column[]>(
    COLUMNS.map((column) => column.key),
  );
  const [columnWidths, setColumnWidths] = useState<Record<Column, number>>({
    primaryValue: 260,
    secondaryValue: 320,
    status: 180,
    tags: 220,
    error: 240,
    source: 220,
    messageId: 150,
    messageDate: 190,
    originalValue: 280,
  });
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [replaceColumn, setReplaceColumn] = useState<Column>("primaryValue");
  const [batchColumn, setBatchColumn] = useState<Column>("status");
  const [batchValue, setBatchValue] = useState("");
  const [focused, setFocused] = useState({ row: 0, col: 0 });
  const [editing, setEditing] = useState<ToolResult | null>(null);
  const [editPrimary, setEditPrimary] = useState("");
  const [editSecondary, setEditSecondary] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editTags, setEditTags] = useState("");
  const anchor = useRef<number | null>(null);
  const visibleColumns = columnOrder
    .map((key) => COLUMNS.find((column) => column.key === key)!)
    .filter((column) => !hidden.has(column.key));
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return results
      .filter((row) => !status || String(row.status || "") === status)
      .filter(
        (row) =>
          !query ||
          COLUMNS.some((column) =>
            value(row, column.key).toLowerCase().includes(query),
          ),
      )
      .sort(
        (left, right) =>
          value(left, sort).localeCompare(value(right, sort), "zh-CN") *
          (direction === "asc" ? 1 : -1),
      );
  }, [results, search, status, sort, direction]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const pageIds = pageRows.map((row) => row.resultKey);
  const chosen = results.filter((row) => selected.has(row.resultKey));
  const statuses = [
    ...new Set(results.map((row) => String(row.status || "success"))),
  ];

  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  function rowSelect(index: number, event: React.MouseEvent) {
    const next = toggleTableRow(
      { mode: "ids", ids: selected },
      pageIds,
      index,
      anchor.current,
      event,
    );
    anchor.current = next.anchor;
    if (next.selection.mode === "ids") setSelected(next.selection.ids);
    setFocused((current) => ({ ...current, row: index }));
  }

  function sortBy(key: Column) {
    if (sort === key)
      setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDirection("asc");
    }
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
    setResults((current) =>
      current.map((row) =>
        row.resultKey === editing.resultKey
          ? {
              ...row,
              primaryValue: editPrimary.trim(),
              secondaryValue: editSecondary.trim(),
              status: editStatus.trim() || "success",
              tags: editTags
                .split(/\r?\n|[,，]/)
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : row,
      ),
    );
    setEditing(null);
    notice("草稿结果已编辑；保存历史时会持久化");
  }

  function removeSelected() {
    if (!selected.size) return;
    if (
      !window.confirm(
        `从当前草稿移除 ${selected.size} 条结果？已保存的原历史不会被删除，可随时重新载入。`,
      )
    )
      return;
    setResults((current) =>
      current.filter((row) => !selected.has(row.resultKey)),
    );
    setSelected(new Set());
    notice("已从当前草稿移除所选结果；原历史仍可恢复");
  }

  function text(rows: ToolResult[]) {
    return rows
      .map((row) =>
        [
          row.primaryValue,
          row.secondaryValue || "",
          row.status || "",
          (row.tags || []).join("|"),
        ].join("\t"),
      )
      .join("\r\n");
  }

  async function copy() {
    const scope = chosen.length ? chosen : filtered;
    if (!scope.length) return;
    try {
      await navigator.clipboard.writeText(text(scope));
      notice(`已复制 ${scope.length.toLocaleString()} 条结果`);
    } catch {
      notice("浏览器拒绝访问剪贴板；请使用上方纯文本输出框手动全选复制");
    }
  }

  function scopeIds() {
    return selected.size
      ? new Set(selected)
      : new Set(filtered.map((row) => row.resultKey));
  }

  function replaceInScope() {
    if (!findText) {
      notice("请输入要查找的文本");
      return;
    }
    const ids = scopeIds();
    if (!ids.size) return;
    const label =
      COLUMNS.find((column) => column.key === replaceColumn)?.label ||
      replaceColumn;
    if (
      !window.confirm(
        `在${selected.size ? `所选 ${ids.size}` : `当前筛选 ${ids.size}`}条结果的“${label}”中执行查找替换？原历史仍保留，可返回历史恢复。`,
      )
    )
      return;
    let changes = 0;
    const nextRows = results.map((row) => {
      if (!ids.has(row.resultKey)) return row;
      const before = value(row, replaceColumn);
      if (!before.includes(findText)) return row;
      const after = before.split(findText).join(replaceText);
      changes += 1;
      return replaceColumn === "tags"
        ? {
            ...row,
            tags: after
              .split(/[|,，\r\n]+/)
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : { ...row, [replaceColumn]: after };
    });
    setResults(nextRows);
    notice(
      `已在草稿中替换 ${changes.toLocaleString()} 行；保存修改后生成新历史，原历史不变`,
    );
  }

  function batchModify() {
    const ids = scopeIds();
    if (!ids.size || !batchValue.trim()) {
      notice("请选择字段并填写批量值");
      return;
    }
    const label =
      COLUMNS.find((column) => column.key === batchColumn)?.label ||
      batchColumn;
    if (
      !window.confirm(
        `把${selected.size ? `所选 ${ids.size}` : `当前筛选 ${ids.size}`}条结果的“${label}”批量修改？原历史仍保留。`,
      )
    )
      return;
    setResults((current) =>
      current.map((row) =>
        ids.has(row.resultKey)
          ? batchColumn === "tags"
            ? {
                ...row,
                tags: batchValue
                  .split(/[|,，\r\n]+/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : { ...row, [batchColumn]: batchValue.trim() }
          : row,
      ),
    );
    notice(`已批量修改 ${ids.size.toLocaleString()} 行草稿；请保存为新历史`);
  }

  function moveColumn(key: Column, offset: -1 | 1) {
    setColumnOrder((current) => {
      const index = current.indexOf(key);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function pasteRange() {
    if (!pageRows.length || !visibleColumns.length) return;
    try {
      const clipboard = await navigator.clipboard.readText();
      const matrix = clipboard
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .filter((line) => line.length)
        .map((line) => line.split("\t"));
      if (!matrix.length) return;
      const updates = new Map<string, ToolResult>();
      for (let rowOffset = 0; rowOffset < matrix.length; rowOffset += 1) {
        const target = pageRows[focused.row + rowOffset];
        if (!target) break;
        let next = { ...target };
        for (
          let columnOffset = 0;
          columnOffset < matrix[rowOffset].length;
          columnOffset += 1
        ) {
          const column = visibleColumns[focused.col + columnOffset];
          if (!column) break;
          const nextValue = matrix[rowOffset][columnOffset];
          if (column.key === "tags")
            next = {
              ...next,
              tags: nextValue
                .split(/[|,，]/)
                .map((item) => item.trim())
                .filter(Boolean),
            };
          else next = { ...next, [column.key]: nextValue };
        }
        updates.set(target.resultKey, next);
      }
      setResults((current) =>
        current.map((row) => updates.get(row.resultKey) || row),
      );
      notice(
        `已从剪贴板粘贴 ${updates.size.toLocaleString()} 行；保存历史后持久化`,
      );
    } catch {
      notice("浏览器拒绝读取剪贴板；请先允许剪贴板权限后重试 Ctrl+V");
    }
  }

  function exportRows(format: "txt" | "csv") {
    if (!chosen.length) return;
    const content =
      format === "txt"
        ? text(chosen)
        : `\uFEFF${[["primary", "secondary", "status", "tags", "source"].map(csvSafe).join(","), ...chosen.map((row) => [row.primaryValue, row.secondaryValue, row.status, (row.tags || []).join("|"), row.source].map(csvSafe).join(","))].join("\r\n")}`;
    download(
      `${tool}-results.${format}`,
      content,
      format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8",
    );
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input,textarea,select,button"))
      return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(filtered.map((row) => row.resultKey)));
    } else if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copy();
    } else if (modifier && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void pasteRange();
    } else if (event.key === "Delete") {
      event.preventDefault();
      removeSelected();
    } else if (event.key === "Enter" && pageRows[focused.row]) {
      event.preventDefault();
      openEdit(pageRows[focused.row]);
    } else if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      setFocused((current) => ({
        row: Math.max(
          0,
          Math.min(
            pageRows.length - 1,
            current.row +
              (event.key === "ArrowUp"
                ? -1
                : event.key === "ArrowDown"
                  ? 1
                  : 0),
          ),
        ),
        col: Math.max(
          0,
          Math.min(
            visibleColumns.length - 1,
            current.col +
              (event.key === "ArrowLeft"
                ? -1
                : event.key === "ArrowRight"
                  ? 1
                  : 0),
          ),
        ),
      }));
    }
  }

  return (
    <div
      className={`stack-md result-table-workspace ${expanded ? "expanded" : ""}`}
      tabIndex={0}
      onKeyDown={keyboard}
    >
      <section className="data-toolbar card">
        <div className="searchbox">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
              setSelected(new Set());
            }}
            placeholder="搜索主值、链接、状态或标签"
          />
        </div>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
            setSelected(new Set());
          }}
        >
          <option value="">全部状态</option>
          {statuses.map((item) => (
            <option key={item} value={item}>
              {statusLabel(item)}
            </option>
          ))}
        </select>
        <button onClick={selectPage}>全选本页</button>
        <button
          onClick={() =>
            setSelected(new Set(filtered.map((row) => row.resultKey)))
          }
        >
          全选筛选结果
        </button>
        <button onClick={() => setColumnsOpen((value) => !value)}>
          列设置
        </button>
        <button onClick={() => setExpanded((value) => !value)}>
          {expanded ? "退出展开" : "展开表格"}
        </button>
      </section>
      {columnsOpen && (
        <section className="card result-columns">
          <strong>列显示、顺序与宽度</strong>
          {columnOrder.map((key) => {
            const column = COLUMNS.find((item) => item.key === key)!;
            return (
              <div className="result-column-setting" key={column.key}>
                <label>
                  <input
                    type="checkbox"
                    checked={!hidden.has(column.key)}
                    onChange={(event) =>
                      setHidden((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(column.key);
                        else next.add(column.key);
                        return next;
                      })
                    }
                  />
                  {column.label}
                </label>
                <input
                  aria-label={`${column.label}列宽`}
                  type="range"
                  min="100"
                  max="600"
                  step="20"
                  value={columnWidths[column.key]}
                  onChange={(event) =>
                    setColumnWidths((current) => ({
                      ...current,
                      [column.key]: Number(event.target.value),
                    }))
                  }
                />
                <span>{columnWidths[column.key]} px</span>
                <button onClick={() => moveColumn(column.key, -1)}>←</button>
                <button onClick={() => moveColumn(column.key, 1)}>→</button>
              </div>
            );
          })}
        </section>
      )}
      <details className="card find-replace-panel">
        <summary>查找替换与批量修改</summary>
        <div className="find-replace-grid">
          <select
            value={replaceColumn}
            onChange={(event) => setReplaceColumn(event.target.value as Column)}
          >
            {COLUMNS.map((column) => (
              <option key={column.key} value={column.key}>
                {column.label}
              </option>
            ))}
          </select>
          <input
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            placeholder="查找文本"
          />
          <input
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            placeholder="替换为（可留空）"
          />
          <button onClick={replaceInScope}>按当前范围替换</button>
          <select
            value={batchColumn}
            onChange={(event) => setBatchColumn(event.target.value as Column)}
          >
            {COLUMNS.filter((column) => column.key !== "primaryValue").map(
              (column) => (
                <option key={column.key} value={column.key}>
                  批量：{column.label}
                </option>
              ),
            )}
          </select>
          <input
            value={batchValue}
            onChange={(event) => setBatchValue(event.target.value)}
            placeholder="批量修改值"
          />
          <button onClick={batchModify}>按当前范围批量修改</button>
        </div>
        <p className="hint">
          有选择时作用于所选；没有选择时作用于当前筛选。修改只进入草稿，保存后生成新历史，原历史保留。
        </p>
      </details>
      {selected.size > 0 && (
        <section className="bulkbar">
          <strong>已选 {selected.size.toLocaleString()} 条</strong>
          <button onClick={() => void copy()}>复制</button>
          <button onClick={() => exportRows("txt")}>TXT</button>
          <button onClick={() => exportRows("csv")}>CSV</button>
          <button onClick={() => openEdit(chosen[0])}>编辑首条</button>
          <button className="danger" onClick={removeSelected}>
            删除草稿行
          </button>
          <button onClick={() => setSelected(new Set())}>清除选择</button>
        </section>
      )}
      <section className="table-card result-sheet-card">
        <div className="table-scroll desktop-only">
          <table className="sheet">
            <thead>
              <tr>
                <th className="check" onClick={selectPage}>
                  <input
                    readOnly
                    type="checkbox"
                    checked={
                      pageIds.length > 0 &&
                      pageIds.every((id) => selected.has(id))
                    }
                  />
                </th>
                <th>#</th>
                {visibleColumns.map((column) => (
                  <th
                    style={{
                      width: columnWidths[column.key],
                      minWidth: columnWidths[column.key],
                    }}
                    key={column.key}
                    onClick={() => sortBy(column.key)}
                  >
                    {column.label}
                    {sort === column.key
                      ? direction === "asc"
                        ? " ↑"
                        : " ↓"
                      : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => (
                <tr
                  key={row.resultKey}
                  className={selected.has(row.resultKey) ? "selected" : ""}
                  onClick={(event) => rowSelect(index, event)}
                  onDoubleClick={() => openEdit(row)}
                >
                  <td className="check">
                    <input
                      readOnly
                      type="checkbox"
                      checked={selected.has(row.resultKey)}
                    />
                  </td>
                  <td>{(page - 1) * pageSize + index + 1}</td>
                  {visibleColumns.map((column, columnIndex) => (
                    <td
                      style={{
                        width: columnWidths[column.key],
                        maxWidth: columnWidths[column.key],
                      }}
                      key={column.key}
                      className={
                        focused.row === index && focused.col === columnIndex
                          ? "focused-cell"
                          : ""
                      }
                    >
                      {value(row, column.key) || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mobile-result-cards mobile-only">
          {pageRows.map((row, index) => (
            <article
              key={row.resultKey}
              className={`mobile-table-card ${selected.has(row.resultKey) ? "selected" : ""}`}
              onClick={(event) => rowSelect(index, event)}
            >
              <div className="mobile-card-heading">
                <input
                  readOnly
                  type="checkbox"
                  checked={selected.has(row.resultKey)}
                />
                <span className="row-index">
                  {(page - 1) * pageSize + index + 1}
                </span>
                <span className="status-chip">{statusLabel(row.status)}</span>
              </div>
              <strong>{row.primaryValue}</strong>
              <p>{row.secondaryValue || row.source || "—"}</p>
              <small>{(row.tags || []).join(" · ") || "无标签"}</small>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  openEdit(row);
                }}
              >
                编辑
              </button>
            </article>
          ))}
        </div>
        {!pageRows.length && (
          <div className="empty compact">
            <strong>当前筛选没有结果</strong>
            <p>回到“1 输入”运行规则，或调整搜索和状态筛选。</p>
          </div>
        )}
        <footer className="pagination">
          <span>
            筛选 {filtered.length.toLocaleString()} / 全部{" "}
            {results.length.toLocaleString()} 条 · 第 {page} / {pages} 页
          </span>
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            <option value="20">20 / 页</option>
            <option value="50">50 / 页</option>
            <option value="100">100 / 页</option>
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
      {editing && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setEditing(null)}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="编辑结果"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">编辑结果</span>
            <label className="field">
              <span>主值</span>
              <input
                value={editPrimary}
                onChange={(event) => setEditPrimary(event.target.value)}
              />
            </label>
            <label className="field">
              <span>辅助值</span>
              <textarea
                rows={3}
                value={editSecondary}
                onChange={(event) => setEditSecondary(event.target.value)}
              />
            </label>
            <label className="field">
              <span>状态</span>
              <input
                value={editStatus}
                onChange={(event) => setEditStatus(event.target.value)}
              />
            </label>
            <label className="field">
              <span>标签（一行一个）</span>
              <textarea
                rows={5}
                value={editTags}
                onChange={(event) => setEditTags(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button className="primary" onClick={saveEdit}>
                保存草稿
              </button>
              <button onClick={() => setEditing(null)}>取消</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

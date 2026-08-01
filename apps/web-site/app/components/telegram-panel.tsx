"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseTelegramOfficialJson } from "../../lib/telegram";
import type { ToolId } from "../../lib/types";

type Source = {
  id: string;
  name: string;
  kind: string;
  external_key: string;
  message_count: number;
};
type Binding = { source_id: string; tool: string };
type QueueRow = {
  id: string;
  message_id: string;
  message_date: string;
  body: string;
  body_deleted_at: string;
  source_id: string;
  source_name: string;
  status: string;
  candidate_count: number;
};
type Selection =
  | { mode: "ids"; ids: Set<string> }
  | { mode: "all"; excluded: Set<string> };
async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
function download(
  name: string,
  content: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TelegramPanel({
  tool,
  onProcessed,
}: {
  tool: ToolId;
  onProcessed: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [configured, setConfigured] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selection, setSelection] = useState<Selection>({
    mode: "ids",
    ids: new Set(),
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const bound = useMemo(
    () =>
      new Set(
        bindings
          .filter((item) => item.tool === tool)
          .map((item) => item.source_id),
      ),
    [bindings, tool],
  );
  const loadStatus = useCallback(
    () =>
      api("/api/telegram")
        .then((payload) => {
          setSources(payload.sources);
          setBindings(payload.bindings);
          setConfigured(payload.configured);
        })
        .catch((error) => setNotice(error.message)),
    [],
  );
  const loadQueue = useCallback(() => {
    const params = new URLSearchParams({
      view: "queue",
      tool,
      page: String(page),
      pageSize: "50",
      status,
      search,
      start,
      end,
    });
    api(`/api/telegram?${params}`)
      .then((payload) => {
        setRows(payload.rows);
        setTotal(payload.total);
      })
      .catch((error) => setNotice(error.message));
  }, [tool, page, status, search, start, end]);
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    const timer = setTimeout(loadQueue, 180);
    return () => clearTimeout(timer);
  }, [loadQueue]);
  async function pull() {
    setBusy(true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pull" }),
      });
      setNotice(
        `Bot 拉取完成：新增 ${result.inserted}，重复 ${result.duplicates}，分发队列 ${result.queues}`,
      );
      loadStatus();
      loadQueue();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "拉取失败");
    } finally {
      setBusy(false);
    }
  }
  async function importJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      if (!/\.json$/i.test(file.name))
        throw new Error("Telegram 官方导入当前只接受 JSON");
      if (file.size > 50 * 1024 * 1024)
        throw new Error("文件超过 50 MB，请在 Telegram Desktop 分卷导出");
      const messages = parseTelegramOfficialJson(JSON.parse(await file.text()));
      let inserted = 0,
        duplicates = 0,
        queues = 0;
      for (let offset = 0; offset < messages.length; offset += 10) {
        const result = await api("/api/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "import",
            messages: messages.slice(offset, offset + 10),
          }),
        });
        inserted += result.inserted;
        duplicates += result.duplicates;
        queues += result.queues;
        setNotice(
          `导入进度 ${Math.min(offset + 10, messages.length)} / ${messages.length}`,
        );
      }
      setNotice(
        `官方 JSON 导入完成：唯一新增 ${inserted}，重复 ${duplicates}，队列 ${queues}`,
      );
      loadStatus();
      loadQueue();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }
  async function bind(sourceId: string, enabled: boolean) {
    setBusy(true);
    try {
      await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "bind", sourceId, tool, enabled }),
      });
      setNotice(`${enabled ? "已绑定" : "已移除"}当前工具来源`);
      loadStatus();
      loadQueue();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }
  const selectedCount =
    selection.mode === "all"
      ? Math.max(0, total - selection.excluded.size)
      : selection.ids.size;
  const isSelected = (id: string) =>
    selection.mode === "all"
      ? !selection.excluded.has(id)
      : selection.ids.has(id);
  const selectionPayload =
    selection.mode === "all"
      ? {
          mode: "all",
          excludeIds: [...selection.excluded],
          status,
          search,
          start,
          end,
        }
      : { mode: "ids", queueIds: [...selection.ids] };
  async function queueAction(action: "process" | "ignored" | "pending") {
    if (!selectedCount) return;
    setBusy(true);
    try {
      if (action === "process") {
        const result = await api("/api/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "process",
            tool,
            ...selectionPayload,
            deleteBody: true,
          }),
        });
        setNotice(
          `处理 ${result.selected} 条消息，得到 ${result.resultCount} 条结果；空结果已标为 processed_empty`,
        );
        onProcessed();
      } else {
        await api("/api/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "queue-status",
            tool,
            ...selectionPayload,
            status: action,
          }),
        });
        setNotice(action === "ignored" ? "已忽略所选消息" : "已恢复为待处理");
      }
      setSelection({ mode: "ids", ids: new Set() });
      loadQueue();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function exportChosen(format: "txt" | "csv") {
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
      download(
        `telegram-${tool}.${format}`,
        result.content,
        format === "csv"
          ? "text/csv;charset=utf-8"
          : "text/plain;charset=utf-8",
      );
      setNotice(`已跨页导出 ${result.count.toLocaleString()} 条所选原文`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出失败");
    }
  }
  const pages = Math.max(1, Math.ceil(total / 50));
  return (
    <div className="telegram-workspace stack-md">
      <section className="callout">
        <strong>当前工具：{tool}</strong>
        <p>
          一个 Bot 只有一条全局 updates
          队列；每次拉取后会一次写入所有已绑定工具。个人账号历史回拉和标已读仍在
          Windows。
        </p>
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">来源与绑定</span>
            <h3>Bot / Telegram 官方 JSON</h3>
          </div>
          <span className={`batch-status ${configured ? "applied" : ""}`}>
            {configured ? "Secret 已配置" : "Secret 未配置"}
          </span>
        </div>
        <div className="button-row">
          <button
            className="primary"
            disabled={!configured || busy}
            onClick={pull}
          >
            手动接收 Bot 更新
          </button>
          <label className="file-button">
            <input type="file" accept=".json" onChange={importJson} />
            {busy ? "处理中…" : "导入官方 JSON"}
          </label>
        </div>
        <div className="source-grid">
          {sources.map((source) => {
            const other = bindings
              .filter(
                (item) => item.source_id === source.id && item.tool !== tool,
              )
              .map((item) => item.tool);
            return (
              <label
                key={source.id}
                className={
                  bound.has(source.id) ? "source-card bound" : "source-card"
                }
              >
                <input
                  type="checkbox"
                  checked={bound.has(source.id)}
                  onChange={(event) => bind(source.id, event.target.checked)}
                  disabled={busy}
                />
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.kind} ·{" "}
                    {Number(source.message_count).toLocaleString()} 条
                    {other.length ? ` · 还绑定 ${other.join(" / ")}` : ""}
                  </small>
                </span>
              </label>
            );
          })}
          {!sources.length && (
            <div className="empty compact">
              <strong>尚未发现来源</strong>
              <p>先拉取 Bot 更新或导入 Telegram 官方 JSON。</p>
            </div>
          )}
        </div>
      </section>
      <section className="card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Telegram 消息工作页</span>
            <h3>{total.toLocaleString()} 条 · 当前工具独立队列</h3>
          </div>
          <span>{selectedCount.toLocaleString()} 已选</span>
        </div>
        <div className="telegram-filters">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
              setSelection({ mode: "ids", ids: new Set() });
            }}
            placeholder="关键词 / 来源 / 消息 ID"
          />
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
              setSelection({ mode: "ids", ids: new Set() });
            }}
          >
            <option value="">全部状态</option>
            <option value="pending">待处理</option>
            <option value="processed">已处理</option>
            <option value="processed_empty">已处理·无结果</option>
            <option value="ignored">已忽略</option>
            <option value="error">异常</option>
          </select>
          <input
            type="datetime-local"
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
              setSelection({ mode: "ids", ids: new Set() });
            }}
          />
          <input
            type="datetime-local"
            value={end}
            onChange={(event) => {
              setEnd(event.target.value);
              setSelection({ mode: "ids", ids: new Set() });
            }}
          />
        </div>
        <div className="button-row">
          <button
            onClick={() =>
              setSelection({
                mode: "ids",
                ids: new Set(rows.map((row) => row.id)),
              })
            }
          >
            全选当前页
          </button>
          {selection.mode === "ids" &&
            selectedCount > 0 &&
            selectedCount < total && (
              <button
                onClick={() =>
                  setSelection({ mode: "all", excluded: new Set() })
                }
              >
                选择全部筛选结果 {total.toLocaleString()} 条
              </button>
            )}
          <button
            disabled={!selectedCount || busy}
            onClick={() => queueAction("process")}
          >
            处理所选
          </button>
          <button
            disabled={!selectedCount || busy}
            onClick={() => queueAction("ignored")}
          >
            忽略
          </button>
          <button
            disabled={!selectedCount || busy}
            onClick={() => queueAction("pending")}
          >
            恢复待处理
          </button>
          <button disabled={!selectedCount} onClick={() => exportChosen("txt")}>
              跨页导出 TXT
          </button>
          <button disabled={!selectedCount} onClick={() => exportChosen("csv")}>
              跨页导出 CSV
          </button>
        </div>
        <div className="telegram-list">
          {rows.map((row) => (
            <label
              key={row.id}
              className={isSelected(row.id) ? "selected" : ""}
            >
              <input
                type="checkbox"
                checked={isSelected(row.id)}
                onChange={() =>
                  setSelection((current) => {
                    if (current.mode === "all") {
                      const excluded = new Set(current.excluded);
                      if (excluded.has(row.id)) excluded.delete(row.id);
                      else excluded.add(row.id);
                      return { mode: "all", excluded };
                    }
                    const ids = new Set(current.ids);
                    if (ids.has(row.id)) ids.delete(row.id);
                    else ids.add(row.id);
                    return { mode: "ids", ids };
                  })
                }
              />
              <span className="row-index">{row.message_id}</span>
              <div>
                <strong>
                  {row.source_name} · {row.status}
                </strong>
                <small>
                  {row.message_date
                    ? new Date(row.message_date).toLocaleString("zh-CN")
                    : "无时间"}{" "}
                  · 候选 {row.candidate_count}
                </small>
                <p>{row.body || "正文已按处理策略删除"}</p>
              </div>
            </label>
          ))}
          {!rows.length && (
            <div className="empty compact">
              <strong>当前筛选没有消息</strong>
              <p>来源绑定后，新消息会进入当前工具的独立队列。</p>
            </div>
          )}
        </div>
        <footer className="pagination">
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
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}

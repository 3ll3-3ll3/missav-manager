"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToolId } from "../../lib/types";

type Source = {
  id: string;
  name: string;
  chat_type?: string;
  external_chat_id: string;
  connection_id: string;
  access_status?: string;
  last_sync_at?: string;
  pending_count?: number;
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

type Selection =
  | { mode: "ids"; ids: Set<string> }
  | { mode: "all"; excluded: Set<string> };

const TOOL_LABELS: Record<ToolId, string> = {
  twitter: "推特博主",
  badnews: "Bad.news",
  haijiao: "海角帖子",
  missav: "MissAV",
  av123: "123AV",
};

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function download(name: string, content: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function TelegramPanel({
  tool,
  onProcessed,
  onOpenTelegramSettings,
}: {
  tool: ToolId;
  onProcessed: () => void;
  onOpenTelegramSettings: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [loadMode, setLoadMode] = useState<"cached" | "recent" | "range" | "oldest" | "incremental">("cached");
  const [selection, setSelection] = useState<Selection>({ mode: "ids", ids: new Set() });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const loadSources = useCallback(async () => {
    try {
      const payload = await api(`/api/telegram?view=tool&tool=${encodeURIComponent(tool)}`);
      const nextSources = (payload.sources || []).filter((source: Source) =>
        (payload.boundSourceIds || []).includes(String(source.id)),
      ) as Source[];
      setSources(nextSources);
      setSelectedSources((current) => {
        const valid = new Set(nextSources.map((source) => source.id));
        let saved: string[] = [];
        try {
          saved = JSON.parse(localStorage.getItem(`telegram-selection:${tool}`) || "[]") as string[];
        } catch {
          saved = [];
        }
        const next = new Set(
          (current.size ? [...current] : saved.length ? saved : nextSources.map((source) => source.id))
            .filter((id) => valid.has(id)),
        );
        return next;
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取当前工具绑定");
    }
  }, [tool]);

  const loadQueue = useCallback(async () => {
    const params = new URLSearchParams({
      view: "queue",
      tool,
      page: String(page),
      pageSize: "50",
      status,
      search,
      start,
      end,
      sourceIds: [...selectedSources].join(","),
    });
    try {
      const payload = await api(`/api/telegram?${params}`);
      setRows(payload.rows || []);
      setTotal(Number(payload.total || 0));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取消息队列");
    }
  }, [tool, page, status, search, start, end, selectedSources]);

  useEffect(() => {
    const timer = setTimeout(() => void loadSources(), 0);
    return () => clearTimeout(timer);
  }, [loadSources]);

  useEffect(() => {
    localStorage.setItem(`telegram-selection:${tool}`, JSON.stringify([...selectedSources]));
  }, [selectedSources, tool]);

  useEffect(() => {
    const timer = setTimeout(() => void loadQueue(), 120);
    return () => clearTimeout(timer);
  }, [loadQueue]);

  const selectedCount = selection.mode === "all"
    ? Math.max(0, total - selection.excluded.size)
    : selection.ids.size;
  const isSelected = (id: string) => selection.mode === "all"
    ? !selection.excluded.has(id)
    : selection.ids.has(id);
  const selectionPayload = selection.mode === "all"
    ? { mode: "all", excludeIds: [...selection.excluded], status, search, start, end, sourceIds: [...selectedSources] }
    : { mode: "ids", queueIds: [...selection.ids] };
  const pages = Math.max(1, Math.ceil(total / 50));
  const selectedSourceRows = useMemo(
    () => sources.filter((source) => selectedSources.has(source.id)),
    [sources, selectedSources],
  );

  function toggleSource(id: string) {
    setPage(1);
    setSelection({ mode: "ids", ids: new Set() });
    setSelectedSources((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleQueue(id: string) {
    setSelection((current) => {
      if (current.mode === "all") {
        const excluded = new Set(current.excluded);
        if (excluded.has(id)) excluded.delete(id);
        else excluded.add(id);
        return { mode: "all", excluded };
      }
      const ids = new Set(current.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { mode: "ids", ids };
    });
  }

  function selectPage() {
    setSelection((current) => {
      if (current.mode === "all") return current;
      const ids = new Set(current.ids);
      for (const row of rows) ids.add(row.id);
      return { mode: "ids", ids };
    });
  }

  async function queueAction(action: "process" | "ignored" | "pending") {
    if (!selectedCount) return;
    setBusy(true);
    try {
      if (action === "process") {
        const result = await api("/api/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "process", tool, ...selectionPayload, deleteBody: true }),
        });
        setNotice(`本次处理 ${result.selected} 条消息，提取 ${result.resultCount} 条结果；各工具队列状态独立保存`);
        onProcessed();
      } else {
        await api("/api/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "queue-status", tool, ...selectionPayload, status: action }),
        });
        setNotice(action === "ignored" ? "已忽略所选消息" : "已恢复为待处理");
      }
      setSelection({ mode: "ids", ids: new Set() });
      await loadQueue();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function exportChosen(format: "txt" | "csv") {
    if (!selectedCount) return;
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "export", tool, format, ...selectionPayload }),
      });
      download(`telegram-${tool}.${format}`, result.content, format === "csv" ? "text/csv;charset=utf-8" : undefined);
      setNotice(`已导出 ${Number(result.count || 0).toLocaleString()} 条消息`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出失败");
    }
  }

  return (
    <div className="telegram-workspace stack-md">
      <section className="callout telegram-layer-callout">
        <strong>{TOOL_LABELS[tool]}：本次选择</strong>
        <p>连接账号、永久绑定和本次选择是三个不同状态。当前页面只允许从已经绑定到本工具的会话中选择本次处理来源。</p>
      </section>

      <section className="card">
        <div className="section-heading">
          <div><span className="eyebrow">Telegram 会话输入</span><h3>选择本次要处理的来源</h3></div>
          <button onClick={onOpenTelegramSettings}>管理绑定</button>
        </div>
        {!sources.length ? (
          <div className="empty compact"><strong>当前工具还没有永久绑定会话</strong><p>请到全局 Telegram 设置的“工具绑定”中选择来源。</p><button className="primary" onClick={onOpenTelegramSettings}>打开工具绑定</button></div>
        ) : (
          <>
            <div className="telegram-source-picker">
              {sources.map((source) => (
                <label key={source.id} className={selectedSources.has(source.id) ? "selected" : ""}>
                  <input type="checkbox" checked={selectedSources.has(source.id)} onChange={() => toggleSource(source.id)} />
                  <span><strong>{source.name}</strong><small>{source.chat_type || "会话"} · {source.external_chat_id}</small></span>
                  <small>{Number(source.pending_count || 0).toLocaleString()} 条待处理</small>
                </label>
              ))}
            </div>
            <div className="button-row">
              <button onClick={() => setSelectedSources(new Set(sources.map((source) => source.id)))}>全选已绑定会话</button>
              <button onClick={() => setSelectedSources(new Set())}>清空本次选择</button>
              <button onClick={onOpenTelegramSettings}>去全局设置同步消息</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="section-heading"><div><span className="eyebrow">本次加载范围</span><h3>{selectedSourceRows.length} 个来源已选择</h3></div><span className="subtle">接收与同步仍由全局设置中心负责</span></div>
        <div className="telegram-filters">
          <select value={loadMode} onChange={(event) => setLoadMode(event.target.value as typeof loadMode)}>
            <option value="cached">已缓存待处理消息</option><option value="recent">最近 N 条</option><option value="range">指定时间范围</option><option value="oldest">从本地最早处继续</option><option value="incremental">从最新位置增量</option>
          </select>
          <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="pending">待处理</option><option value="processing">处理中</option><option value="processed">已处理</option><option value="processed_empty">空结果</option><option value="ignored">已忽略</option><option value="deleted">远端已删除</option><option value="">全部状态</option></select>
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索消息、来源或消息 ID" />
          <input type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); setPage(1); }} aria-label="开始时间" />
          <input type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); setPage(1); }} aria-label="结束时间" />
          <button onClick={() => void loadQueue()}>刷新队列</button>
        </div>
        <p className="subtle">当前选择只影响本工具本次队列视图；不会修改永久绑定，也不会连接 Telegram 或调用 getUpdates。</p>
      </section>

      <section className="card">
        <div className="section-heading"><div><span className="eyebrow">独立工具队列</span><h3>{total.toLocaleString()} 条消息</h3></div><div className="button-row"><button onClick={selectPage}>选择当前页</button><button onClick={() => setSelection({ mode: "all", excluded: new Set() })}>选择全部筛选结果</button><button onClick={() => setSelection({ mode: "ids", ids: new Set() })}>清除选择</button></div></div>
        {selectedCount > 0 && <div className="button-row queue-actions"><strong>已选择 {selectedCount.toLocaleString()} 条</strong><button className="primary" disabled={busy} onClick={() => void queueAction("process")}>处理所选</button><button disabled={busy} onClick={() => void queueAction("ignored")}>忽略</button><button disabled={busy} onClick={() => void queueAction("pending")}>恢复待处理</button><button disabled={busy} onClick={() => void exportChosen("txt")}>导出 TXT</button><button disabled={busy} onClick={() => void exportChosen("csv")}>导出 CSV</button></div>}
        <div className="telegram-list">
          {rows.map((row) => <label key={row.id} className={isSelected(row.id) ? "selected" : ""}><input type="checkbox" disabled={row.status === "deleted"} checked={isSelected(row.id)} onChange={() => toggleQueue(row.id)} /><span className="queue-status">{row.status}</span><span><strong>{row.source_name}</strong><small>{row.message_date} · #{row.message_id}{row.event_kind === "edited" ? " · 已编辑" : ""}</small></span><span className="queue-preview">{row.remote_deleted_at ? "Telegram 远端消息已删除" : row.body || "正文已按队列处理策略清理"}</span><small>{row.candidate_count ? `${row.candidate_count} 条结果` : row.status === "deleted" ? "不可处理" : "未处理"}</small></label>)}
          {!rows.length && <div className="empty compact"><strong>当前筛选没有消息</strong><p>先在全局设置中心同步消息，或调整来源、状态和时间筛选。</p></div>}
        </div>
        <div className="pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {page} / {pages} 页</span><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
      </section>
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}

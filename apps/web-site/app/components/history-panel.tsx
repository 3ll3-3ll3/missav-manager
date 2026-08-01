"use client";

import { useCallback, useEffect, useState } from "react";
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
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export default function HistoryPanel({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [notice, setNotice] = useState("");
  const [renameName, setRenameName] = useState("");
  const load = useCallback(() => {
    const params = new URLSearchParams({
      search,
      tool,
      page: String(page),
      pageSize: "30",
    });
    api(`/api/runs?${params}`)
      .then((payload) => {
        setRows(payload.rows);
        setTotal(payload.total);
      })
      .catch((error) => setNotice(error.message));
  }, [search, tool, page]);
  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load, refreshKey]);
  async function open(id: string, nextPage = 1) {
    try {
      const payload = await api(
        `/api/runs?id=${id}&resultPage=${nextPage}&resultPageSize=100`,
      );
      setDetail(payload);
      setDetailPage(nextPage);
      setRenameName(payload.run.name);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取失败");
    }
  }
  async function rename() {
    if (!detail || !renameName.trim()) return;
    try {
      await api("/api/runs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: detail.run.id, name: renameName }),
      });
      setNotice("历史名称已更新");
      await open(detail.run.id, detailPage);
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重命名失败");
    }
  }
  async function remove(run: Run) {
    if (
      !window.confirm(
        `删除历史“${run.name}”？系统会先建立恢复点，永久记录不会被删除。`,
      )
    )
      return;
    try {
      const result = await api(`/api/runs?id=${run.id}`, { method: "DELETE" });
      if (detail?.run.id === run.id) setDetail(null);
      setNotice(
        result.snapshotId
          ? `历史已删除；恢复点 ${result.snapshotId.slice(0, 8)}… 已保存`
          : "历史已删除并已保存恢复点",
      );
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    }
  }
  const pages = Math.max(1, Math.ceil(total / 30));
  const detailPages = Math.max(1, Math.ceil((detail?.total || 0) / 100));
  return (
    <div className="history-layout">
      <section className="card history-list">
        <div className="section-heading">
          <div>
            <span className="eyebrow">永久历史</span>
            <h3>处理批次</h3>
          </div>
          <span className="count-chip">{total.toLocaleString()}</span>
        </div>
        <div className="filter-row">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="搜索历史名称"
          />
          <select
            value={tool}
            onChange={(event) => {
              setTool(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部工具</option>
            <option value="twitter">推特</option>
            <option value="badnews">Bad.news</option>
            <option value="haijiao">海角</option>
            <option value="missav">MissAV</option>
            <option value="av123">123AV</option>
          </select>
        </div>
        {notice && <div className="notice">{notice}</div>}
        <div className="run-list">
          {rows.map((run) => (
            <button
              key={run.id}
              className={detail?.run.id === run.id ? "active" : ""}
              onClick={() => open(run.id)}
            >
              <span className={`tool-chip ${run.tool}`}>{run.tool}</span>
              <div>
                <strong>{run.name}</strong>
                <small>
                  {run.result_count.toLocaleString()} 条 ·{" "}
                  {new Date(run.created_at).toLocaleString("zh-CN")}
                </small>
              </div>
              <span>›</span>
            </button>
          ))}
          {!rows.length && (
            <div className="empty compact">
              <strong>暂无历史</strong>
              <p>内容处理结果保存后会出现在这里。</p>
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
      <section className="card history-detail">
        {detail ? (
          <>
            <div className="section-heading">
              <div>
                <span className="eyebrow">批次详情</span>
                <h3>{detail.run.name}</h3>
              </div>
              <div className="button-row">
                <button
                  onClick={() => {
                    window.location.href = `/api/export?runId=${detail.run.id}`;
                  }}
                >
                  导出完整 JSON
                </button>
                <button className="danger" onClick={() => remove(detail.run)}>
                  删除并建恢复点
                </button>
              </div>
            </div>
            <div className="rename-row">
              <input
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && rename()}
              />
              <button onClick={rename}>保存名称</button>
            </div>
            <dl className="detail-meta">
              <div>
                <dt>工具</dt>
                <dd>{detail.run.tool}</dd>
              </div>
              <div>
                <dt>结果</dt>
                <dd>{detail.total.toLocaleString()} 条</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{detail.run.source_summary || "—"}</dd>
              </div>
            </dl>
            <div className="detail-results">
              {detail.results.map((row, index) => (
                <div key={String(row.id)}>
                  <span>{(detailPage - 1) * 100 + index + 1}</span>
                  <strong>{String(row.primary_value)}</strong>
                  <small>
                    {String(row.secondary_value || row.source || "")}
                  </small>
                </div>
              ))}
            </div>
            <footer className="pagination">
              <span>
                结果第 {detailPage} / {detailPages} 页
              </span>
              <button
                disabled={detailPage <= 1}
                onClick={() => open(detail.run.id, detailPage - 1)}
              >
                上一页
              </button>
              <button
                disabled={detailPage >= detailPages}
                onClick={() => open(detail.run.id, detailPage + 1)}
              >
                下一页
              </button>
            </footer>
          </>
        ) : (
          <div className="empty">
            <span>◷</span>
            <strong>选择一条处理历史</strong>
            <p>批次详情和结果均使用服务端分页，不会一次载入整批。</p>
          </div>
        )}
      </section>
    </div>
  );
}

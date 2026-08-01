"use client";
import { useCallback, useEffect, useState } from "react";
type Log = {
  id: string;
  level: string;
  category: string;
  message: string;
  detail_json: string;
  created_at: string;
};
async function api(url: string) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
export default function LogsPanel() {
  const [rows, setRows] = useState<Log[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(() => {
    const params = new URLSearchParams({ level, search, page: String(page), pageSize: "50" });
    api(`/api/logs?${params}`)
      .then((payload) => { setRows(payload.rows); setTotal(payload.total); })
      .catch((error) => setNotice(error.message));
  }, [level, search, page]);
  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load]);
  return (
    <div className="stack-md">
      <section className="callout">
        <strong>只读脱敏日志</strong>
        <p>
          日志不提供编辑或删除入口；Bot
          Token、手机号、验证码和密码模式会在写入前脱敏。
        </p>
      </section>
      <section className="data-toolbar card">
        <div className="searchbox">
          <span>⌕</span>
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="搜索类别或消息"
          />
        </div>
        <select value={level} onChange={(e) => { setLevel(e.target.value); setPage(1); }}>
          <option value="">全部级别</option>
          <option>info</option>
          <option>warning</option>
          <option>error</option>
        </select>
        <button onClick={load}>刷新</button>
      </section>
      {notice && <div className="notice">{notice}</div>}
      <section className="log-list card">
        {rows.map((row) => (
          <article key={row.id}>
            <span className={`batch-status ${row.level}`}>{row.level}</span>
            <div>
              <strong>
                {row.category} · {row.message}
              </strong>
              <small>{new Date(row.created_at).toLocaleString("zh-CN")}</small>
              <pre>{row.detail_json}</pre>
            </div>
          </article>
        ))}
        {!rows.length && (
          <div className="empty compact">
            <strong>暂无日志</strong>
          </div>
        )}
      </section>
      <footer className="pagination card"><span>共 {total.toLocaleString()} 条 · 第 {page} / {Math.max(1, Math.ceil(total / 50))} 页</span><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= Math.max(1, Math.ceil(total / 50))} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>
    </div>
  );
}

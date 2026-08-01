"use client";
import { useCallback, useEffect, useState } from "react";
type Task = {
  id: string;
  tool: string;
  stage: string;
  title: string;
  run_id: string;
  updated_at: string;
};
async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
const stages = ["new", "filtered", "website", "review", "error", "completed"];
export default function TaskCenter() {
  const [rows, setRows] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [stage, setStage] = useState("");
  const [tool, setTool] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const load = useCallback(() => {
    const params = new URLSearchParams({
      stage,
      tool,
      search,
      page: String(page),
      pageSize: "50",
    });
    api(`/api/tasks?${params}`)
      .then((payload) => {
        setRows(payload.rows);
        setTotal(payload.total);
      })
      .catch((error) => setNotice(error.message));
  }, [stage, tool, search, page]);
  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load]);
  async function move(next: string) {
    await api("/api/tasks", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [...selected], stage: next }),
    });
    setSelected(new Set());
    setNotice("任务阶段已更新");
    load();
  }
  return (
    <div className="stack-md">
      <section className="data-toolbar card">
        <div className="searchbox">
          <span>⌕</span>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
              setSelected(new Set());
            }}
            placeholder="搜索任务"
          />
        </div>
        <select value={tool} onChange={(e) => { setTool(e.target.value); setPage(1); setSelected(new Set()); }}>
          <option value="">全部工具</option>
          {["twitter", "badnews", "haijiao", "missav", "av123"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); setSelected(new Set()); }}>
          <option value="">全部阶段</option>
          {stages.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        {selected.size > 0 && (
          <>
            <strong>已选 {selected.size}</strong>
            <select
              defaultValue=""
              onChange={(e) => e.target.value && move(e.target.value)}
            >
              <option value="">批量改阶段…</option>
              {stages.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </>
        )}
      </section>
      {notice && <div className="notice">{notice}</div>}
      <section className="table-card">
        <div className="table-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th className="check"></th>
                <th>工具</th>
                <th>阶段</th>
                <th>任务</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={selected.has(row.id) ? "selected" : ""}
                  onClick={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  <td className="check">
                    <input
                      readOnly
                      type="checkbox"
                      checked={selected.has(row.id)}
                    />
                  </td>
                  <td>
                    <span className={`tool-chip ${row.tool}`}>{row.tool}</span>
                  </td>
                  <td>
                    <span className="status-chip">{row.stage}</span>
                  </td>
                  <td>{row.title}</td>
                  <td>{new Date(row.updated_at).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="pagination">
          <span>共 {total.toLocaleString()} 条 · 第 {page} / {Math.max(1, Math.ceil(total / 50))} 页</span>
          <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
          <button disabled={page >= Math.max(1, Math.ceil(total / 50))} onClick={() => setPage((value) => value + 1)}>下一页</button>
        </footer>
      </section>
    </div>
  );
}

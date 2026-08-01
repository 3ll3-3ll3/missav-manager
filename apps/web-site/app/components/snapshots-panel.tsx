"use client";
import { useEffect, useState } from "react";
type Snapshot = {
  id: string;
  reason: string;
  entity: string;
  item_count: number;
  status: string;
  created_at: string;
  restored_at: string;
};
async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
export default function SnapshotsPanel() {
  const [rows, setRows] = useState<Snapshot[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api("/api/snapshots")
      .then((payload) => setRows(payload.snapshots))
      .catch((error) => setNotice(error.message));
  useEffect(() => {
    void load();
  }, []);
  async function restore(row: Snapshot) {
    if (
      !window.confirm(
        `恢复“${row.reason}”中的 ${row.item_count} 项？恢复操作会写回业务数据。`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api("/api/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", snapshotId: row.id }),
      });
      setNotice(`已恢复 ${result.restored} 项`);
      void load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="section-heading">
        <div>
          <span className="eyebrow">操作恢复点</span>
          <h3>删除、批改和迁移前快照</h3>
        </div>
        <button onClick={() => void load()}>刷新</button>
      </div>
      {notice && <div className="notice">{notice}</div>}
      <div className="batch-list">
        {rows.map((row) => (
          <div key={row.id}>
            <div>
              <strong>{row.reason}</strong>
              <small>
                {row.entity} · {row.item_count.toLocaleString()} 项 ·{" "}
                {new Date(row.created_at).toLocaleString("zh-CN")}
              </small>
            </div>
            <span className={`batch-status ${row.status}`}>{row.status}</span>
            {row.status === "ready" && (
              <button disabled={busy} onClick={() => restore(row)}>
                恢复
              </button>
            )}
          </div>
        ))}
        {!rows.length && (
          <div className="empty compact">
            <strong>暂无恢复点</strong>
            <p>高影响操作执行前会自动建立。</p>
          </div>
        )}
      </div>
    </section>
  );
}

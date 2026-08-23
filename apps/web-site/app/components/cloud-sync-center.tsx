"use client";

import { useCallback, useEffect, useState } from "react";

type ConflictRow = {
  id: string;
  entity_type: string;
  entity_key: string;
  reason: string;
  status: string;
  created_at: string;
};

type SyncStatus = {
  gateway: { configured: boolean; online: boolean; error?: string };
  nodeId: string;
  paired: boolean;
  dirty: number;
  pendingUpload: number;
  conflicts: number;
  lastPulledSequence: number;
  lastSuccessAt: string;
  lastError: string;
  preview: Record<string, unknown>;
  previewExpiresAt: string;
  conflictRows: ConflictRow[];
};

async function request(input?: Record<string, unknown>) {
  const response = await fetch(input ? "/api/cloud-sync" : "/api/cloud-sync?test=1", input ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  } : { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
  return body;
}

function when(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function hasFreshPreview(status: SyncStatus) {
  return Boolean(status.preview?.generatedAt && Date.parse(status.previewExpiresAt) > Date.now());
}

export default function CloudSyncCenter() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [previewActive, setPreviewActive] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const next = await request() as unknown as SyncStatus;
      setStatus(next);
      setPreviewActive(hasFreshPreview(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步状态读取失败");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void request().then((value) => {
      if (!active) return;
      const next = value as unknown as SyncStatus;
      setStatus(next);
      setPreviewActive(hasFreshPreview(next));
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "同步状态读取失败");
    });
    return () => { active = false; };
  }, []);

  async function run(action: string, mode?: "push" | "pull" | "both") {
    setBusy(mode || action);
    setNotice("");
    setError("");
    try {
      const result = await request({ action, ...(mode ? { mode } : {}) });
      if (action === "preview") {
        setNotice(`预览已生成：待上传 ${Number(result.pendingUpload || 0)} 条，待下载约 ${Number(result.pendingDownload || 0)} 条。`);
      } else if (action === "retry-conflicts") {
        setNotice(`已选择保留网页内容并将 ${Number(result.retried || 0)} 条冲突放回重试队列，请重新生成预览。`);
      } else {
        let continuation = result;
        let rounds = 1;
        while (continuation.incomplete === true) {
          if (rounds >= 250) throw new Error("同步仍有大量待处理数据，已安全停止；请刷新状态后继续，不会丢失进度。");
          const nextPreview = await request({ action: "preview" });
          setNotice(`正在继续第 ${rounds + 1} 轮：待上传 ${Number(nextPreview.pendingUpload || 0)} 条，待下载约 ${Number(nextPreview.pendingDownload || 0)} 条。`);
          continuation = await request({ action: "execute", ...(mode ? { mode } : {}) });
          rounds += 1;
        }
        setNotice(mode === "both" ? "双向同步完成。" : mode === "push" ? "网页数据 Push 完成。" : "云端数据 Pull 完成。");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步失败");
    } finally {
      setBusy("");
    }
  }

  async function resolveConflict(id: string, choice: "remote" | "local") {
    setBusy(`resolve-${id}`);
    setNotice("");
    setError("");
    try {
      const result = await request({ action: "resolve-conflict", id, choice });
      setNotice(choice === "remote" ? "已采用另一端内容。" : result.requiresPreview ? "已保留网页内容，请重新生成预览后 Push。" : "已保留网页内容。");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "冲突处理失败");
    } finally {
      setBusy("");
    }
  }

  const configured = Boolean(status?.gateway.configured);
  const pendingDownload = Number(status?.preview?.pendingDownload || 0);

  return <div className="stack-lg cloud-sync-center">
    <section className="hero sync-hero">
      <div>
        <span className="pill">WINDOWS ↔ PRIVATE WEB</span>
        <h2>双向同步中心</h2>
        <p>网页 D1 与 Windows SQLite 保持各自独立，通过增量网关同步重要记录、处理历史、Telegram 消息与队列、检查点、已读状态和 MissAV 规则库。</p>
        <div className="button-row">
          <button className="primary" disabled={Boolean(busy) || !configured} onClick={() => run("preview")}>{busy === "preview" ? "正在核对…" : "生成同步预览"}</button>
          <button disabled={Boolean(busy)} onClick={load}>刷新状态</button>
        </div>
      </div>
      <div className="hero-gauge"><span>网关状态</span><strong>{status?.gateway.online ? "在线" : configured ? "离线" : "未配置"}</strong><small>{status?.paired ? "网站节点已安全配对" : "首次预览时自动建立网站节点"}</small></div>
    </section>

    {notice && <div className="notice">{notice}</div>}
    {(error || status?.lastError) && <section className="callout warning"><strong>同步需要处理</strong><p>{error || status?.lastError}</p></section>}
    {!configured && <section className="callout warning"><strong>尚未接入同步网关</strong><p>请先在 Sites 的安全设置中配置 SYNC_GATEWAY_URL 与 SYNC_ADMIN_TOKEN。页面、日志和仓库不会显示它们的值。</p></section>}

    <section className="metric-grid sync-metrics">
      <Metric label="待登记变更" value={status?.dirty} note="业务事务自动记录" />
      <Metric label="待上传" value={status?.pendingUpload} note="网页 → 同步网关" />
      <Metric label="待下载（预览）" value={pendingDownload} note={`游标 ${status?.lastPulledSequence || 0}`} />
      <Metric label="冲突" value={status?.conflicts} note="不会静默覆盖" />
    </section>

    <section className="card">
      <div className="section-heading"><div><span className="eyebrow">安全执行</span><h3>Push、Pull 或双向同步</h3></div><small className="subtle">最近成功：{when(status?.lastSuccessAt)}</small></div>
      <p className="subtle">必须先生成预览。预览后本端数据或下载游标变化时，执行会拒绝并要求重新预览；Pull 应用期间不会反向制造重复 outbox。</p>
      <div className="button-row sync-action-row">
        <button disabled={Boolean(busy) || !previewActive} onClick={() => run("execute", "push")}>{busy === "push" ? "Push 中…" : "仅 Push（网页 → 云端）"}</button>
        <button disabled={Boolean(busy) || !previewActive} onClick={() => run("execute", "pull")}>{busy === "pull" ? "Pull 中…" : "仅 Pull（云端 → 网页）"}</button>
        <button className="primary" disabled={Boolean(busy) || !previewActive} onClick={() => run("execute", "both")}>{busy === "both" ? "双向同步中…" : "双向同步"}</button>
      </div>
      <div className="sync-preview-summary">
        <span>节点：{status?.nodeId || "—"}</span>
        <span>预览生成：{when(status?.preview?.generatedAt)}</span>
        <span>预览失效：{when(status?.previewExpiresAt)}</span>
      </div>
    </section>

    <section className="card">
      <div className="section-heading"><div><span className="eyebrow">可见冲突</span><h3>冲突与重试</h3></div><button disabled={Boolean(busy) || !status?.conflicts} onClick={() => run("retry-conflicts")}>全部保留网页并重试</button></div>
      <p className="subtle">当网页和 Windows 分别修改同一条记录时，不会自动覆盖。你可以逐条采用另一端，或明确保留网页内容并在新预览后 Push。</p>
      <div className="table-scroll sync-conflict-scroll">
        <table className="sheet"><thead><tr><th>状态</th><th>实体</th><th>自然键</th><th>原因</th><th>发生时间</th><th>处理</th></tr></thead>
          <tbody>{(status?.conflictRows || []).map((row) => <tr key={row.id}><td><span className="status-chip">{row.status}</span></td><td>{row.entity_type}</td><td title={row.entity_key}>{row.entity_key}</td><td>{row.reason}</td><td>{when(row.created_at)}</td><td><div className="button-row"><button disabled={Boolean(busy) || row.status !== "open"} onClick={() => resolveConflict(row.id, "remote")}>采用另一端</button><button disabled={Boolean(busy) || row.status !== "open"} onClick={() => resolveConflict(row.id, "local")}>保留网页</button></div></td></tr>)}</tbody>
        </table>
        {!status?.conflictRows?.length && <div className="empty compact"><strong>当前没有同步冲突</strong><p>两端修改会在这里留下可审计记录。</p></div>}
      </div>
    </section>

    <section className="callout"><strong>不会同步的内容</strong><p>Telegram Token、api_hash、验证码、Session、2FA 密码、Cookie、Raindrop Token、代理地址和本地文件路径只留在各自执行端。</p></section>
  </div>;
}

function Metric({ label, value, note }: { label: string; value: number | undefined; note: string }) {
  return <article className="metric"><span>{label}</span><strong>{value === undefined ? "—" : value.toLocaleString()}</strong><small>{note}</small></article>;
}

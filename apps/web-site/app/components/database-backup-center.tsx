"use client";

import { useEffect, useState } from "react";

type InventoryTable = { name: string; rowCount: number; primaryKey: string[] };
type InventoryResponse = {
  inspectedAt: string;
  source: { siteVersion: number; candidateSiteVersion: number; commit: string; tree: string; database: string };
  security: { telegramSession: string; decrypted: boolean; displayed: boolean };
  tableCount: number;
  totalRows: number;
  tables: InventoryTable[];
};

async function jsonApi(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export default function DatabaseBackupCenter() {
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [fileName, setFileName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);

  async function loadInventory() {
    setBusy(true);
    try {
      setInventory(await jsonApi("/api/database-backup?action=inventory"));
      setNotice("轻量清单已更新：仅查询 Schema 与逐表 COUNT(*)，未读取业务行、未修改数据库。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    jsonApi("/api/database-backup?action=inventory")
      .then((value) => {
        if (!cancelled) {
          setInventory(value);
          setNotice("轻量清单已更新：未自动生成完整备份。");
        }
      })
      .catch((error) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "读取失败");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, []);

  function downloadBackup() {
    const anchor = document.createElement("a");
    anchor.href = "/api/database-backup?action=download";
    anchor.download = "";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setNotice("已显式启动分页流式备份。请在下载完成后用本页校验完整性与一致性完成标记。");
  }

  async function validateFile(file?: File) {
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const result = await jsonApi("/api/database-backup?action=validate", {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body: file,
      });
      setNotice(`备份校验通过：${result.tableCount} 张表，共 ${Number(result.totalRows).toLocaleString()} 行；SHA-256 ${result.sha256}。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "备份文件校验失败");
    } finally {
      setBusy(false);
    }
  }

  return <div className="stack-md">
    <section className="callout warning"><strong>Site v28 备份中心候选（未部署）</strong><p>v27 未获部署批准；本修订候选对正式 D1 只读：轻量表清单、显式流式下载、备份文件校验。生产恢复入口与写入 API 已移除；JSON/NDJSON 恢复只允许在全新临时 D1 演练。</p></section>
    <section className="metric-grid"><article className="metric"><span>业务表</span><strong>{inventory?.tableCount ?? "—"}</strong><small>必须完整等于 25</small></article><article className="metric"><span>总行数</span><strong>{inventory ? inventory.totalRows.toLocaleString() : "—"}</strong><small>仅 COUNT(*) 轻量统计</small></article><article className="metric"><span>正式基线</span><strong>{inventory ? `Site v${inventory.source.siteVersion}` : "—"}</strong><small>{inventory?.source.tree.slice(0, 12) || "源码树待读取"}</small></article><article className="metric"><span>候选版本</span><strong>{inventory ? `v${inventory.source.candidateSiteVersion}` : "—"}</strong><small>仅保存，不部署</small></article></section>
    <section className="card"><div className="section-heading"><div><span className="eyebrow">只读表清单</span><h3>逐表轻量统计</h3></div><div className="button-row"><button disabled={busy} onClick={loadInventory}>重新统计</button><button className="primary" disabled={busy || !inventory} onClick={downloadBackup}>生成并下载完整备份</button></div></div><p className="subtle">页面打开不会读取全部业务行。只有点击下载后，Worker 才以 250 行有界分页输出 NDJSON，并在文件末尾写入双遍一致性复核结果。</p><div className="backup-table-scroll"><table className="sheet"><thead><tr><th>表</th><th>行数</th><th>主键</th></tr></thead><tbody>{inventory?.tables.map((table) => <tr key={table.name}><td className="strong-cell">{table.name}</td><td>{table.rowCount.toLocaleString()}</td><td>{table.primaryKey.join(", ") || "—"}</td></tr>)}</tbody></table></div></section>
    <section className="card"><span className="eyebrow">只读文件校验</span><h3>选择完整备份 NDJSON</h3><p className="subtle">流式复算 25 表、列定义、分页顺序、行数、逐表 SHA-256、总清单 SHA-256 与双遍一致性完成标记。校验不会写入 D1。</p><label className="dropzone"><input type="file" accept="application/x-ndjson,.ndjson" disabled={busy} onChange={(event) => void validateFile(event.target.files?.[0])} /><strong>{fileName || "选择备份文件"}</strong><span>NDJSON · 只读校验 · 无生产恢复入口</span></label></section>
    <section className="callout"><strong>正式迁移前置门槛</strong><p>未来正式迁移必须先在 Cloudflare 控制面记录正式 D1 的 Time Travel bookmark；本候选不会获取 bookmark，也不会执行迁移、恢复或 0006。</p></section>
    {notice && <section className="notice">{notice}</section>}
  </div>;
}

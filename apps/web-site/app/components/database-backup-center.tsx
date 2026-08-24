"use client";

import { useEffect, useState } from "react";

type TableManifest = { name: string; rowCount: number; sha256: string; primaryKey: string[] };
type ManifestResponse = {
  createdAt: string;
  source: { siteVersion: number; commit: string; tree: string; database: string };
  security: { telegramSession: string; decrypted: boolean; displayed: boolean };
  manifest: { tableCount: number; totalRows: number; sha256: string; tables: TableManifest[] };
};

const CONFIRMATION = "RESTORE 25 TABLES";

async function jsonApi(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export default function DatabaseBackupCenter() {
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [backup, setBackup] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);

  async function loadManifest() {
    setBusy(true);
    try {
      setManifest(await jsonApi("/api/database-backup?action=manifest"));
      setNotice("已只读核对 25 张表、行数和 SHA-256。未修改数据库。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    jsonApi("/api/database-backup?action=manifest")
      .then((value) => {
        if (!cancelled) {
          setManifest(value);
          setNotice("已只读核对 25 张表、行数和 SHA-256。未修改数据库。");
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

  async function downloadBackup() {
    setBusy(true);
    try {
      const response = await fetch("/api/database-backup", { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "备份下载失败");
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const name = disposition.match(/filename="([^"]+)"/)?.[1] || "tg-content-toolbox-site-v26-d1.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice("完整 JSON 备份已下载。Telegram Session 仅以原始加密密文存在。 ");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "下载失败");
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(file?: File) {
    if (!file) return;
    setConfirmation("");
    setFileName(file.name);
    try {
      const parsed = JSON.parse(await file.text());
      setBackup(parsed);
      const result = await jsonApi("/api/database-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate", backup: parsed }),
      });
      setNotice(`恢复前校验通过：${result.tableCount} 张表，共 ${Number(result.totalRows).toLocaleString()} 行。`);
    } catch (error) {
      setBackup(null);
      setNotice(error instanceof Error ? error.message : "备份文件校验失败");
    }
  }

  async function restore() {
    if (!backup || confirmation !== CONFIRMATION) return;
    setBusy(true);
    try {
      const result = await jsonApi("/api/database-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", confirmation, backup }),
      });
      setNotice(`恢复完成并复核：${result.tableCount} 张表，共 ${Number(result.totalRows).toLocaleString()} 行。`);
      setConfirmation("");
      await loadManifest();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  }

  return <div className="stack-md">
    <section className="callout warning"><strong>完整 D1 备份与恢复</strong><p>固定覆盖正式 Site v26 的 25 张业务表。清单只显示表名、行数和 SHA-256；Telegram Session 不解密、不预览，只在下载文件中保留不透明加密密文。</p></section>
    <section className="metric-grid"><article className="metric"><span>业务表</span><strong>{manifest?.manifest.tableCount ?? "—"}</strong><small>必须完整等于 25</small></article><article className="metric"><span>总行数</span><strong>{manifest ? manifest.manifest.totalRows.toLocaleString() : "—"}</strong><small>逐表只读统计</small></article><article className="metric"><span>Site 基线</span><strong>{manifest ? `v${manifest.source.siteVersion}` : "—"}</strong><small>{manifest?.source.tree.slice(0, 12) || "源码树待读取"}</small></article><article className="metric"><span>清单 SHA-256</span><strong className="backup-hash">{manifest?.manifest.sha256.slice(0, 12) || "—"}</strong><small>下载与恢复前复算</small></article></section>
    <section className="card"><div className="section-heading"><div><span className="eyebrow">备份清单</span><h3>逐表行数与摘要</h3></div><div className="button-row"><button disabled={busy} onClick={loadManifest}>重新核对</button><button className="primary" disabled={busy || !manifest} onClick={downloadBackup}>下载完整备份</button></div></div><div className="backup-table-scroll"><table className="sheet"><thead><tr><th>表</th><th>行数</th><th>主键</th><th>SHA-256</th></tr></thead><tbody>{manifest?.manifest.tables.map((table) => <tr key={table.name}><td className="strong-cell">{table.name}</td><td>{table.rowCount.toLocaleString()}</td><td>{table.primaryKey.join(", ") || "—"}</td><td className="checksum">{table.sha256}</td></tr>)}</tbody></table></div></section>
    <section className="card"><span className="eyebrow">恢复前校验</span><h3>选择完整备份 JSON</h3><p className="subtle">先校验格式、25 表清单、列定义、逐表行数、逐表 SHA-256 与总清单 SHA-256。校验阶段不会写入 D1。</p><label className="dropzone"><input type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event.target.files?.[0])} /><strong>{fileName || "选择备份文件"}</strong><span>JSON · 仅在确认恢复后才会写入</span></label>{backup !== null && <><label className="field"><span>输入 {CONFIRMATION} 以解锁恢复</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button className="danger" disabled={busy || confirmation !== CONFIRMATION} onClick={restore}>恢复全部 25 张表</button></>}</section>
    {notice && <section className="notice">{notice}</section>}
  </div>;
}

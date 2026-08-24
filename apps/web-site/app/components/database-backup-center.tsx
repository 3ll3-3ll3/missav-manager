"use client";

import { useEffect, useRef, useState } from "react";
import {
  backupManifestDigest,
  backupRecordLine,
  DATABASE_BACKUP_FORMAT,
  DATABASE_BACKUP_INITIAL_DIGEST,
  DATABASE_BACKUP_PAGE_MAX_ROWS,
  DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES,
  nextBackupDigest,
  type BackupManifestEntry,
  type BackupRow,
  type BackupValue,
  type ColumnInfo,
} from "../../lib/database-backup-format";

type InventoryTable = {
  name: string; rowCount: number; primaryKey: string[];
  columns: ColumnInfo[]; schemaSha256: string;
};
type InventoryResponse = {
  inspectedAt: string;
  source: { siteVersion: number; candidateSiteVersion: number; commit: string; tree: string; database: string };
  security: { telegramSession: string; decrypted: boolean; displayed: boolean };
  tableCount: number; totalRows: number; bookmark: string; queryCount: number;
  tables: InventoryTable[];
};
type PageResponse = {
  table: string; nextCursor: BackupValue[] | null; done: boolean; rows: BackupRow[];
  rowCount: number; utf8Bytes: number; schemaSha256: string; bookmark: string;
  consistent: boolean; queryCount: number;
};
type BackupJob = {
  id: "active"; status: "running" | "paused" | "complete" | "invalid";
  phase: "export" | "verify" | "finalize"; createdAt: string;
  inventory: InventoryResponse; tableIndex: number; cursor: BackupValue[] | null;
  sessionBookmark: string;
  pageIndex: number; currentRows: number; currentDigest: string;
  manifests: BackupManifestEntry[]; sequence: number; requestCount: number;
  maxQueries: number; exportedRows: number; error: string;
  validationSha256?: string; validationQueryCount?: number;
};
type Chunk = { id: string; jobId: "active"; sequence: number; line: string };

const DATABASE_NAME = "tg-content-toolbox-v29-backup";
const JOB_ID = "active" as const;

async function jsonApi(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器本地备份存储失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("浏览器本地备份事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("浏览器本地备份事务中止"));
  });
}

async function openBackupDatabase() {
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("jobs")) database.createObjectStore("jobs", { keyPath: "id" });
    if (!database.objectStoreNames.contains("chunks")) {
      const chunks = database.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("jobId", "jobId");
    }
  };
  return requestValue(request);
}

async function loadJob() {
  const database = await openBackupDatabase();
  try {
    return await requestValue(database.transaction("jobs").objectStore("jobs").get(JOB_ID)) as BackupJob | undefined;
  } finally { database.close(); }
}

function makeChunks(job: BackupJob, records: unknown[]) {
  return records.map((record) => {
    const sequence = job.sequence++;
    return { id: `${JOB_ID}:${String(sequence).padStart(12, "0")}`, jobId: JOB_ID, sequence, line: backupRecordLine(record) } satisfies Chunk;
  });
}

async function saveJob(job: BackupJob, chunks: Chunk[] = []) {
  const database = await openBackupDatabase();
  try {
    const transaction = database.transaction(["jobs", "chunks"], "readwrite");
    transaction.objectStore("jobs").put(job);
    for (const chunk of chunks) transaction.objectStore("chunks").put(chunk);
    await transactionDone(transaction);
  } finally { database.close(); }
}

async function replaceJob(job: BackupJob, records: unknown[]) {
  const chunks = makeChunks(job, records);
  const database = await openBackupDatabase();
  try {
    const transaction = database.transaction(["jobs", "chunks"], "readwrite");
    transaction.objectStore("chunks").clear();
    transaction.objectStore("jobs").put(job);
    for (const chunk of chunks) transaction.objectStore("chunks").put(chunk);
    await transactionDone(transaction);
  } finally { database.close(); }
}

async function loadLines() {
  const database = await openBackupDatabase();
  try {
    const chunks = await requestValue(database.transaction("chunks").objectStore("chunks").index("jobId").getAll(JOB_ID)) as Chunk[];
    return chunks.sort((left, right) => left.sequence - right.sequence).map((chunk) => chunk.line);
  } finally { database.close(); }
}

function headerRecord(inventory: InventoryResponse, createdAt: string) {
  return {
    type: "header", format: DATABASE_BACKUP_FORMAT, createdAt,
    source: inventory.source, security: inventory.security, tableCount: 25,
    pageMaxRows: DATABASE_BACKUP_PAGE_MAX_ROWS,
    pageMaxUtf8Bytes: DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES,
    hashAlgorithm: "SHA-256 chained canonical pages",
    consistency: "d1-bookmark-and-double-scan", startBookmark: inventory.bookmark,
  };
}

async function footerRecord(job: BackupJob, complete: boolean, endBookmark: string, error?: string) {
  return {
    type: "footer", complete, tableCount: job.manifests.length,
    totalRows: job.manifests.reduce((sum, table) => sum + table.rowCount, 0),
    sha256: await backupManifestDigest(job.manifests), tables: job.manifests,
    consistency: "d1-bookmark-and-double-scan",
    startBookmark: job.inventory.bookmark, endBookmark,
    ...(error ? { error } : {}),
  };
}

function backupFileName(createdAt: string, invalid = false) {
  return `tg-content-toolbox-site-v26-d1-v29-${createdAt.replace(/[:.]/g, "-")}${invalid ? "-INVALID" : ""}.ndjson`;
}

export default function DatabaseBackupCenter() {
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [job, setJob] = useState<BackupJob | null>(null);
  const [fileName, setFileName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const pauseRequested = useRef(false);
  const runnerActive = useRef(false);

  async function loadInventory() {
    setBusy(true);
    try {
      const value = await jsonApi("/api/database-backup?action=inventory") as InventoryResponse;
      setInventory(value);
      setNotice(`轻量清单已更新：单次 ${value.queryCount} 次 D1 查询，未读取业务行、未修改数据库。`);
      return value;
    } finally { setBusy(false); }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      jsonApi("/api/database-backup?action=inventory") as Promise<InventoryResponse>,
      loadJob(),
    ]).then(async ([value, saved]) => {
      if (cancelled) return;
      const normalized = saved?.status === "running" ? { ...saved, status: "paused" as const } : saved;
      if (normalized && normalized !== saved) await saveJob(normalized);
      if (cancelled) return;
      setInventory(value); setJob(normalized ?? null);
      setNotice(normalized
        ? `已找到浏览器本地${normalized.status === "complete" ? "完成" : "可续传"}备份：${normalized.requestCount} 个请求。`
        : `轻量清单已更新：单次 ${value.queryCount} 次 D1 查询；未自动读取全部行。`);
    }).catch((error) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : "读取失败");
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  async function markInvalid(active: BackupJob, message: string, endBookmark = "") {
    active.status = "invalid"; active.error = message;
    const footer = await footerRecord(active, false, endBookmark, "source_changed_during_backup");
    await saveJob(active, makeChunks(active, [footer]));
    setJob({ ...active }); setNotice(`备份已明确判定无效：${message}`);
  }

  async function runBackup(starting: BackupJob) {
    if (runnerActive.current) return;
    runnerActive.current = true;
    pauseRequested.current = false;
    const active = starting;
    active.status = "running"; active.error = "";
    await saveJob(active); setJob({ ...active });
    try {
      while (active.status === "running") {
        if (pauseRequested.current) {
          active.status = "paused"; await saveJob(active); setJob({ ...active });
          setNotice("备份已在最近一次完整响应后暂停，可从已保存的表与主键游标继续。");
          break;
        }
        if (active.phase === "finalize") {
          const result = await jsonApi("/api/database-backup?action=finalize", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookmark: active.sessionBookmark }),
          }) as { consistent: boolean; endBookmark: string; queryCount: number };
          active.requestCount += 1; active.maxQueries = Math.max(active.maxQueries, result.queryCount);
          if (result.queryCount > 30 || !result.consistent) {
            await markInvalid(active, "最终 D1 Session bookmark 回退", result.endBookmark); break;
          }
          active.sessionBookmark = result.endBookmark;
          const footer = await footerRecord(active, true, result.endBookmark);
          const validation = await jsonApi("/api/database-backup?action=validate", {
            method: "POST", headers: { "Content-Type": "application/x-ndjson" },
            body: new Blob([...(await loadLines()), backupRecordLine(footer)], { type: "application/x-ndjson" }),
          });
          active.requestCount += 1;
          active.maxQueries = Math.max(active.maxQueries, Number(validation.queryCount));
          active.validationSha256 = String(validation.sha256);
          active.validationQueryCount = Number(validation.queryCount);
          active.status = "complete";
          await saveJob(active, makeChunks(active, [footer])); setJob({ ...active });
          setNotice(`完整备份已生成并回读校验：${active.requestCount} 个浏览器请求，单请求最多 ${active.maxQueries} 次 D1 查询；文件 SHA-256 ${active.validationSha256}。`);
          break;
        }

        const table = active.inventory.tables[active.tableIndex];
        if (!table) throw new Error("备份进度超出 25 表清单");
        const response = await jsonApi("/api/database-backup?action=page", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table: table.name, cursor: active.cursor, bookmark: active.sessionBookmark }),
        }) as PageResponse;
        active.requestCount += 1; active.maxQueries = Math.max(active.maxQueries, response.queryCount);
        if (response.queryCount > 30) { await markInvalid(active, "单请求 D1 查询数超过 30", response.bookmark); break; }
        if (!response.consistent) { await markInvalid(active, `${table.name} D1 Session bookmark 回退`, response.bookmark); break; }
        active.sessionBookmark = response.bookmark;
        if (response.table !== table.name || response.schemaSha256 !== table.schemaSha256) { await markInvalid(active, `${table.name} Schema 已变化`, response.bookmark); break; }
        if (!response.done && (!response.rows.length || !response.nextCursor)) throw new Error(`${table.name} 分页游标没有前进`);

        const records: unknown[] = [];
        if (active.phase === "export" && active.pageIndex === 0) {
          records.push({ type: "table", name: table.name, columns: table.columns, primaryKey: table.primaryKey });
        }
        if (response.rows.length) {
          active.currentDigest = await nextBackupDigest(active.currentDigest, active.pageIndex, response.rows);
          active.currentRows += response.rows.length;
          if (active.phase === "export") {
            records.push({ type: "page", table: table.name, index: active.pageIndex, rows: response.rows });
            active.exportedRows += response.rows.length;
          }
          active.pageIndex += 1;
        }
        active.cursor = response.nextCursor;

        if (response.done) {
          if (active.phase === "export") {
            if (active.currentRows !== table.rowCount) { await markInvalid(active, `${table.name} 行数与起始清单不一致`, response.bookmark); break; }
            const manifest = { name: table.name, rowCount: active.currentRows, sha256: active.currentDigest, primaryKey: table.primaryKey };
            active.manifests.push(manifest); records.push({ type: "table_end", ...manifest });
          } else {
            const expected = active.manifests[active.tableIndex];
            if (!expected || expected.rowCount !== active.currentRows || expected.sha256 !== active.currentDigest) {
              await markInvalid(active, `${table.name} 第二遍 SHA-256 或行数不一致`, response.bookmark); break;
            }
          }
          active.tableIndex += 1; active.cursor = null; active.pageIndex = 0;
          active.currentRows = 0; active.currentDigest = DATABASE_BACKUP_INITIAL_DIGEST;
          if (active.tableIndex === active.inventory.tables.length) {
            if (active.phase === "export") { active.phase = "verify"; active.tableIndex = 0; }
            else active.phase = "finalize";
          }
        }
        await saveJob(active, makeChunks(active, records)); setJob({ ...active });
      }
    } catch (error) {
      active.status = "paused"; active.error = error instanceof Error ? error.message : "备份请求中断";
      await saveJob(active); setJob({ ...active });
      setNotice(`请求已安全暂停，正式 D1 未被修改：${active.error}`);
    } finally { runnerActive.current = false; }
  }

  async function startBackup() {
    if (job && !window.confirm("开始新备份会清除当前浏览器中的旧候选文件与续传进度，是否继续？")) return;
    try {
      const fresh = await loadInventory();
      const createdAt = new Date().toISOString();
      const active: BackupJob = {
        id: JOB_ID, status: "running", phase: "export", createdAt, inventory: fresh,
        tableIndex: 0, cursor: null, sessionBookmark: fresh.bookmark, pageIndex: 0, currentRows: 0,
        currentDigest: DATABASE_BACKUP_INITIAL_DIGEST, manifests: [], sequence: 0,
        requestCount: 1, maxQueries: fresh.queryCount, exportedRows: 0, error: "",
      };
      await replaceJob(active, [headerRecord(fresh, createdAt)]); setJob({ ...active });
      setNotice("已开始浏览器驱动的第一遍导出；每个完成页都会保存到 IndexedDB。 ");
      await runBackup(active);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法开始备份"); }
  }

  async function resumeBackup() {
    const saved = await loadJob();
    if (!saved || (saved.status !== "paused" && saved.status !== "running")) return;
    await runBackup(saved);
  }

  function pauseBackup() { pauseRequested.current = true; setNotice("正在等待当前只读分页请求结束后安全暂停……"); }

  async function downloadBackup() {
    const saved = await loadJob();
    if (!saved || (saved.status !== "complete" && saved.status !== "invalid")) return;
    const blob = new Blob(await loadLines(), { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = backupFileName(saved.createdAt, saved.status === "invalid");
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setNotice(saved.status === "complete" ? "完整备份已下载；请使用下方入口再次校验文件。" : "已下载带 complete=false 的无效证据文件；不得用于恢复演练。");
  }

  async function validateStoredBackup() {
    const saved = await loadJob();
    if (!saved || saved.status !== "complete") return;
    setBusy(true);
    try {
      const result = await jsonApi("/api/database-backup?action=validate", {
        method: "POST", headers: { "Content-Type": "application/x-ndjson" },
        body: new Blob(await loadLines(), { type: "application/x-ndjson" }),
      });
      saved.requestCount += 1;
      saved.maxQueries = Math.max(saved.maxQueries, Number(result.queryCount));
      saved.validationSha256 = String(result.sha256);
      saved.validationQueryCount = Number(result.queryCount);
      await saveJob(saved); setJob({ ...saved });
      setNotice(`浏览器已将完整文件回传同一 owner-only Site 校验通过：${result.tableCount} 张表，${Number(result.totalRows).toLocaleString()} 行，SHA-256 ${result.sha256}。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "浏览器完整文件回读校验失败"); }
    finally { setBusy(false); }
  }

  async function validateFile(file?: File) {
    if (!file) return;
    setFileName(file.name); setBusy(true);
    try {
      const result = await jsonApi("/api/database-backup?action=validate", {
        method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: file,
      });
      setNotice(`备份校验通过：${result.tableCount} 张表，共 ${Number(result.totalRows).toLocaleString()} 行；SHA-256 ${result.sha256}；校验请求 ${result.queryCount} 次 D1 查询。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "备份文件校验失败"); }
    finally { setBusy(false); }
  }

  const running = job?.status === "running";
  const resumable = job?.status === "paused";
  const downloadable = job?.status === "complete" || job?.status === "invalid";
  const progress = job ? Math.min(100, Math.round(((job.phase === "export" ? 0 : 25) + job.tableIndex) / 50 * 100)) : 0;

  return <div className="stack-md">
    <section className="callout warning"><strong>Site v29 备份中心候选（未部署）</strong><p>正式 D1 只读。完整备份由所有者浏览器分成多次请求，按稳定主键游标、行数与 UTF-8 字节双重分页；服务端不保存任务、游标或临时数据。生产恢复与单请求全库下载均保持禁用。</p></section>
    <section className="metric-grid"><article className="metric"><span>业务表</span><strong>{inventory?.tableCount ?? "—"}</strong><small>必须完整等于 25</small></article><article className="metric"><span>总行数</span><strong>{inventory ? inventory.totalRows.toLocaleString() : "—"}</strong><small>Schema + COUNT 合计 {inventory?.queryCount ?? "—"} 次查询</small></article><article className="metric"><span>备份请求</span><strong>{job?.requestCount ?? "—"}</strong><small>单请求最多 {job?.maxQueries ?? "—"} 次 D1 查询</small></article><article className="metric"><span>候选版本</span><strong>v29</strong><small>正式仍为 Site v26</small></article></section>
    {job && <section className={`card operation-progress-card${job.status === "invalid" ? " failed" : ""}`}><div className="operation-progress-heading"><div><span className="eyebrow">浏览器本地续传状态</span><h3>{job.status === "complete" ? "双遍复核完成" : job.status === "invalid" ? "文件已判定无效" : job.phase === "export" ? "第一遍导出" : "第二遍复核"}</h3></div><span className="operation-progress-percent">{progress}%</span></div><progress max={100} value={progress} /><div className="operation-progress-metrics"><span>{job.exportedRows.toLocaleString()} 行已写入本地分块</span><span>{job.requestCount} 个请求</span><span>单请求最多 {job.maxQueries} 次查询</span><span>{job.status === "paused" ? "可续传" : job.status === "invalid" ? job.error : job.validationSha256 ? `文件校验 ${job.validationSha256.slice(0, 12)}…` : "每页完成后持久化"}</span></div></section>}
    <section className="card"><div className="section-heading"><div><span className="eyebrow">只读表清单</span><h3>合并 Schema 与 COUNT 统计</h3></div><div className="button-row"><button disabled={busy || running} onClick={() => void loadInventory()}>重新统计</button><button className="primary" disabled={busy || running} onClick={() => void startBackup()}>开始新备份</button>{running && <button onClick={pauseBackup}>安全暂停</button>}{resumable && <button className="primary" onClick={() => void resumeBackup()}>继续备份</button>}<button disabled={job?.status !== "complete" || busy} onClick={() => void validateStoredBackup()}>回读校验浏览器备份</button><button disabled={!downloadable} onClick={() => void downloadBackup()}>{job?.status === "invalid" ? "下载无效证据文件" : "下载完整备份"}</button></div></div><p className="subtle">页面打开只执行 2 次查询，不读取全部业务行。每个分页请求固定 2 次查询，最多 {DATABASE_BACKUP_PAGE_MAX_ROWS} 行且目标不超过 {(DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES / 1024).toLocaleString()} KiB（单行超限时只返回该行）；D1 bookmark 在请求间单调延续，第一遍与第二遍的逐表 SHA-256 必须完全一致。</p><div className="backup-table-scroll"><table className="sheet"><thead><tr><th>表</th><th>行数</th><th>稳定主键</th></tr></thead><tbody>{inventory?.tables.map((table) => <tr key={table.name}><td className="strong-cell">{table.name}</td><td>{table.rowCount.toLocaleString()}</td><td>{table.primaryKey.join(", ")}</td></tr>)}</tbody></table></div></section>
    <section className="card"><span className="eyebrow">只读文件校验</span><h3>选择完整备份 NDJSON</h3><p className="subtle">流式复算 25 表、Schema、分页顺序、行数、逐表 SHA-256、总清单 SHA-256、双遍完成标记与首尾 bookmark；服务端只用 1 次 Schema 查询且不写 D1。</p><label className="dropzone"><input type="file" accept="application/x-ndjson,.ndjson" disabled={busy || running} onChange={(event) => void validateFile(event.target.files?.[0])} /><strong>{fileName || "选择备份文件"}</strong><span>NDJSON · owner-only · 无生产恢复入口</span></label></section>
    <section className="callout"><strong>一致性与回滚边界</strong><p>D1 bookmark 在请求间延续以保证单调读取；Schema 变化、起始行数变化或第二遍逐表摘要不一致时，最终文件都会写入 complete=false。正式迁移前仍必须另行记录 D1 Time Travel bookmark；本候选不会执行迁移、恢复或 0006。</p></section>
    {notice && <section className="notice">{notice}</section>}
  </div>;
}

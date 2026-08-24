"use client";

import { useEffect, useRef, useState } from "react";
import {
  backupManifestDigest, DATABASE_BACKUP_FORMAT, DATABASE_BACKUP_INITIAL_DIGEST,
  DATABASE_BACKUP_PAGE_MAX_ROWS, DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES,
  nextBackupDigest, type BackupRow, type BackupValue,
} from "../../lib/database-backup-format";
import {
  BACKUP_CHECKPOINT_VERSION, BACKUP_JOB_ID, BACKUP_WHOLE_FILE_MEMORY_LIMIT_BYTES,
  clearBackupStorage, cloneBackupJob, commitBackupCheckpoint, inspectBackupStorage,
  loadBackupJob, loadBackupLines, makeBackupChunks, replaceBackupCheckpoint,
  type BackupChunkBatch, type BackupInventory, type BackupJob,
} from "../../lib/database-backup-indexeddb";

type PageResponse = {
  table: string; nextCursor: BackupValue[] | null; done: boolean; rows: BackupRow[];
  rowCount: number; utf8Bytes: number; schemaSha256: string; bookmark: string;
  consistent: boolean; queryCount: number;
};

class CheckpointPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "浏览器本地备份事务失败");
    this.name = "CheckpointPersistenceError";
  }
}

async function jsonApi(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function headerRecord(inventory: BackupInventory, createdAt: string) {
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
  return `tg-content-toolbox-site-v26-d1-v30-${createdAt.replace(/[:.]/g, "-")}${invalid ? "-INVALID" : ""}.ndjson`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value.toLocaleString()} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function ensureWholeFileMemoryBudget(bytes: number) {
  if (bytes > BACKUP_WHOLE_FILE_MEMORY_LIMIT_BYTES) {
    throw new Error(`本地备份约 ${formatBytes(bytes)}，超过整文件内存操作上限 ${formatBytes(BACKUP_WHOLE_FILE_MEMORY_LIMIT_BYTES)}；已阻止 getAll() + Blob，避免浏览器内存耗尽。`);
  }
}

function applyChunkBatch(base: BackupJob, nextJob: BackupJob, records: unknown[]) {
  const batch = makeBackupChunks(base.sequence, records);
  nextJob.sequence = batch.nextSequence;
  nextJob.storedBytes = base.storedBytes + batch.utf8Bytes;
  return batch;
}

export default function DatabaseBackupCenter() {
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [job, setJob] = useState<BackupJob | null>(null);
  const [fileName, setFileName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [localStoredBytes, setLocalStoredBytes] = useState(0);
  const [localDataPresent, setLocalDataPresent] = useState(false);
  const [storageProblem, setStorageProblem] = useState("");
  const pauseRequested = useRef(false);
  const runnerActive = useRef(false);

  async function loadInventory() {
    setBusy(true);
    try {
      const value = await jsonApi("/api/database-backup?action=inventory") as BackupInventory;
      setInventory(value);
      setNotice(`轻量清单已更新：单次 ${value.queryCount} 次 D1 查询，未读取业务行、未修改数据库。`);
      return value;
    } finally { setBusy(false); }
  }

  async function commitAndShow(nextJob: BackupJob, batch: BackupChunkBatch = { chunks: [], nextSequence: nextJob.sequence, utf8Bytes: 0 }) {
    try {
      await commitBackupCheckpoint(nextJob, batch.chunks);
    } catch (error) {
      throw new CheckpointPersistenceError(error);
    }
    const committed = cloneBackupJob(nextJob);
    setJob(committed);
    setLocalStoredBytes(committed.storedBytes);
    setLocalDataPresent(true);
    return committed;
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      jsonApi("/api/database-backup?action=inventory") as Promise<BackupInventory>,
      loadBackupJob(), inspectBackupStorage(),
    ]).then(async ([value, saved, stats]) => {
      if (cancelled) return;
      setInventory(value);
      setLocalStoredBytes(stats.storedBytes);
      setLocalDataPresent(Boolean(saved) || stats.chunkCount > 0);
      if (!saved) {
        setNotice(`轻量清单已更新：单次 ${value.queryCount} 次 D1 查询；未自动读取全部行。`);
        return;
      }
      if (saved.checkpointVersion !== BACKUP_CHECKPOINT_VERSION) {
        setStorageProblem("发现 v29 旧式检查点。它无法证明 job 与 chunks 原子一致，v30 拒绝静默续传；请删除后重新备份。");
        setNotice("已阻止不安全的 v29 旧检查点续传，正式 D1 未被访问或修改。");
        return;
      }
      if (!stats.contiguous || saved.sequence !== stats.nextSequence || saved.storedBytes !== stats.storedBytes) {
        setStorageProblem("本地 job 与 chunks 不构成完整原子检查点，已拒绝续传；请删除本地数据后重新备份。");
        setNotice("检测到浏览器本地检查点不完整，未推进任何游标。");
        return;
      }
      let normalized = cloneBackupJob(saved);
      if (normalized.status === "running") {
        normalized = { ...normalized, status: "paused", error: "页面刷新后从最后一个完整检查点暂停" };
        await commitBackupCheckpoint(normalized, []);
      }
      if (cancelled) return;
      setJob(cloneBackupJob(normalized));
      setNotice(`已找到浏览器本地${normalized.status === "complete" ? "完成" : "可续传"}备份：${normalized.requestCount} 个请求，${formatBytes(normalized.storedBytes)}。`);
    }).catch((error) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : "读取失败");
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  async function recoverCheckpoint(checkpoint: BackupJob, error: unknown, persistenceFailed: boolean) {
    const message = error instanceof Error ? error.message : "备份请求中断";
    let recovered = await loadBackupJob().catch(() => undefined);
    if (!recovered || recovered.checkpointVersion !== BACKUP_CHECKPOINT_VERSION) recovered = cloneBackupJob(checkpoint);
    if (!persistenceFailed) {
      const paused = { ...cloneBackupJob(recovered), status: "paused" as const, error: message };
      try { await commitBackupCheckpoint(paused, []); recovered = paused; } catch { /* keep durable checkpoint */ }
    }
    const display = { ...cloneBackupJob(recovered), status: "paused" as const, error: message };
    setJob(display);
    setLocalStoredBytes(recovered.storedBytes);
    setLocalDataPresent(true);
    setNotice(persistenceFailed
      ? `本页网络响应已成功，但 job + chunk 原子事务失败；已丢弃下一状态并回到旧检查点。重试会再次请求同一游标：${message}`
      : `请求已从最后一个完整检查点安全暂停，正式 D1 未被修改：${message}`);
  }

  async function persistInvalid(observed: BackupJob, message: string, endBookmark = "") {
    const nextJob = { ...cloneBackupJob(observed), status: "invalid" as const, error: message };
    const footer = await footerRecord(nextJob, false, endBookmark, "source_changed_during_backup");
    const batch = applyChunkBatch(observed, nextJob, [footer]);
    await commitAndShow(nextJob, batch);
    setNotice(`备份已明确判定无效：${message}`);
    return nextJob;
  }

  async function runBackup(starting: BackupJob) {
    if (runnerActive.current) return;
    runnerActive.current = true;
    pauseRequested.current = false;
    let checkpoint = cloneBackupJob(starting);
    try {
      checkpoint = await commitAndShow({ ...cloneBackupJob(checkpoint), status: "running", error: "" });
      while (checkpoint.status === "running") {
        if (pauseRequested.current) {
          checkpoint = await commitAndShow({ ...cloneBackupJob(checkpoint), status: "paused" });
          setNotice("备份已在最近一次完整原子检查点后暂停，可从已保存的表与主键游标继续。");
          break;
        }
        if (checkpoint.phase === "finalize") {
          const result = await jsonApi("/api/database-backup?action=finalize", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookmark: checkpoint.sessionBookmark }),
          }) as { consistent: boolean; endBookmark: string; queryCount: number };
          const observed = cloneBackupJob(checkpoint);
          observed.requestCount += 1;
          observed.maxQueries = Math.max(observed.maxQueries, result.queryCount);
          observed.sessionBookmark = result.endBookmark;
          if (result.queryCount > 30 || !result.consistent) {
            checkpoint = await persistInvalid(observed, "最终 D1 Session bookmark 回退", result.endBookmark); break;
          }
          const footer = await footerRecord(observed, true, result.endBookmark);
          const batch = makeBackupChunks(checkpoint.sequence, [footer]);
          ensureWholeFileMemoryBudget(checkpoint.storedBytes + batch.utf8Bytes);
          const validation = await jsonApi("/api/database-backup?action=validate", {
            method: "POST", headers: { "Content-Type": "application/x-ndjson" },
            body: new Blob([...(await loadBackupLines()), ...batch.chunks.map((chunk) => chunk.line)], { type: "application/x-ndjson" }),
          });
          const completeJob = {
            ...cloneBackupJob(observed), status: "complete" as const,
            requestCount: observed.requestCount + 1,
            maxQueries: Math.max(observed.maxQueries, Number(validation.queryCount)),
            validationSha256: String(validation.sha256), validationQueryCount: Number(validation.queryCount),
            sequence: batch.nextSequence, storedBytes: checkpoint.storedBytes + batch.utf8Bytes,
          };
          checkpoint = await commitAndShow(completeJob, batch);
          setNotice(`完整备份已生成并回读校验：${checkpoint.requestCount} 个浏览器请求，单请求最多 ${checkpoint.maxQueries} 次 D1 查询；文件 SHA-256 ${checkpoint.validationSha256}。`);
          break;
        }

        const table = checkpoint.inventory.tables[checkpoint.tableIndex];
        if (!table) throw new Error("备份进度超出 25 表清单");
        const response = await jsonApi("/api/database-backup?action=page", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table: table.name, cursor: checkpoint.cursor, bookmark: checkpoint.sessionBookmark }),
        }) as PageResponse;
        const nextJob = cloneBackupJob(checkpoint);
        nextJob.requestCount += 1;
        nextJob.maxQueries = Math.max(nextJob.maxQueries, response.queryCount);
        nextJob.sessionBookmark = response.bookmark;
        if (response.queryCount > 30) { checkpoint = await persistInvalid(nextJob, "单请求 D1 查询数超过 30", response.bookmark); break; }
        if (!response.consistent) { checkpoint = await persistInvalid(nextJob, `${table.name} D1 Session bookmark 回退`, response.bookmark); break; }
        if (response.table !== table.name || response.schemaSha256 !== table.schemaSha256) { checkpoint = await persistInvalid(nextJob, `${table.name} Schema 已变化`, response.bookmark); break; }
        if (!response.done && (!response.rows.length || !response.nextCursor)) throw new Error(`${table.name} 分页游标没有前进`);

        const records: unknown[] = [];
        if (checkpoint.phase === "export" && checkpoint.pageIndex === 0) records.push({ type: "table", name: table.name, columns: table.columns, primaryKey: table.primaryKey });
        if (response.rows.length) {
          nextJob.currentDigest = await nextBackupDigest(checkpoint.currentDigest, checkpoint.pageIndex, response.rows);
          nextJob.currentRows = checkpoint.currentRows + response.rows.length;
          if (checkpoint.phase === "export") {
            records.push({ type: "page", table: table.name, index: checkpoint.pageIndex, rows: response.rows });
            nextJob.exportedRows = checkpoint.exportedRows + response.rows.length;
          }
          nextJob.pageIndex = checkpoint.pageIndex + 1;
        }
        nextJob.cursor = response.nextCursor;
        if (response.done) {
          if (checkpoint.phase === "export") {
            if (nextJob.currentRows !== table.rowCount) { checkpoint = await persistInvalid(nextJob, `${table.name} 行数与起始清单不一致`, response.bookmark); break; }
            const manifest = { name: table.name, rowCount: nextJob.currentRows, sha256: nextJob.currentDigest, primaryKey: [...table.primaryKey] };
            nextJob.manifests = [...checkpoint.manifests, manifest];
            records.push({ type: "table_end", ...manifest });
          } else {
            const expected = checkpoint.manifests[checkpoint.tableIndex];
            if (!expected || expected.rowCount !== nextJob.currentRows || expected.sha256 !== nextJob.currentDigest) {
              checkpoint = await persistInvalid(nextJob, `${table.name} 第二遍 SHA-256 或行数不一致`, response.bookmark); break;
            }
          }
          nextJob.tableIndex = checkpoint.tableIndex + 1;
          nextJob.cursor = null; nextJob.pageIndex = 0; nextJob.currentRows = 0;
          nextJob.currentDigest = DATABASE_BACKUP_INITIAL_DIGEST;
          if (nextJob.tableIndex === checkpoint.inventory.tables.length) {
            if (checkpoint.phase === "export") { nextJob.phase = "verify"; nextJob.tableIndex = 0; }
            else nextJob.phase = "finalize";
          }
        }
        const batch = applyChunkBatch(checkpoint, nextJob, records);
        checkpoint = await commitAndShow(nextJob, batch);
      }
    } catch (error) {
      await recoverCheckpoint(checkpoint, error instanceof CheckpointPersistenceError ? error.cause : error, error instanceof CheckpointPersistenceError);
    } finally { runnerActive.current = false; }
  }

  async function startBackup() {
    if (localDataPresent && !window.confirm("开始新备份会清除当前浏览器中的旧候选文件与续传进度，是否继续？")) return;
    try {
      const fresh = await loadInventory();
      const createdAt = new Date().toISOString();
      const headerBatch = makeBackupChunks(0, [headerRecord(fresh, createdAt)]);
      const initial: BackupJob = {
        id: BACKUP_JOB_ID, checkpointVersion: BACKUP_CHECKPOINT_VERSION,
        status: "paused", phase: "export", createdAt, inventory: fresh,
        tableIndex: 0, cursor: null, sessionBookmark: fresh.bookmark,
        pageIndex: 0, currentRows: 0, currentDigest: DATABASE_BACKUP_INITIAL_DIGEST,
        manifests: [], sequence: headerBatch.nextSequence,
        requestCount: 1, maxQueries: fresh.queryCount, exportedRows: 0,
        storedBytes: headerBatch.utf8Bytes, error: "",
      };
      await replaceBackupCheckpoint(initial, headerBatch.chunks);
      setStorageProblem(""); setLocalDataPresent(true); setLocalStoredBytes(initial.storedBytes);
      setJob(cloneBackupJob(initial));
      setNotice("已建立 v30 原子检查点并开始第一遍导出；每个完成页的 job + chunks 会在同一 IndexedDB 事务中提交。");
      await runBackup(initial);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法开始备份"); }
  }

  async function resumeBackup() {
    const saved = await loadBackupJob();
    if (!saved || saved.checkpointVersion !== BACKUP_CHECKPOINT_VERSION || (saved.status !== "paused" && saved.status !== "running")) return;
    await runBackup(saved);
  }

  function pauseBackup() { pauseRequested.current = true; setNotice("正在等待当前只读分页请求结束，并提交最后一个完整原子检查点……"); }

  async function downloadBackup() {
    const saved = await loadBackupJob();
    if (!saved || (saved.status !== "complete" && saved.status !== "invalid")) return;
    try {
      ensureWholeFileMemoryBudget(saved.storedBytes);
      const blob = new Blob(await loadBackupLines(), { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = backupFileName(saved.createdAt, saved.status === "invalid");
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(saved.status === "complete" ? "完整备份已下载；请使用下方入口再次校验文件。" : "已下载带 complete=false 的无效证据文件；不得用于恢复演练。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "下载失败"); }
  }

  async function validateStoredBackup() {
    const saved = await loadBackupJob();
    if (!saved || saved.status !== "complete") return;
    setBusy(true);
    try {
      ensureWholeFileMemoryBudget(saved.storedBytes);
      const result = await jsonApi("/api/database-backup?action=validate", {
        method: "POST", headers: { "Content-Type": "application/x-ndjson" },
        body: new Blob(await loadBackupLines(), { type: "application/x-ndjson" }),
      });
      const nextJob = {
        ...cloneBackupJob(saved), requestCount: saved.requestCount + 1,
        maxQueries: Math.max(saved.maxQueries, Number(result.queryCount)),
        validationSha256: String(result.sha256), validationQueryCount: Number(result.queryCount),
      };
      await commitAndShow(nextJob);
      setNotice(`浏览器已将完整文件回传同一 owner-only Site 校验通过：${result.tableCount} 张表，${Number(result.totalRows).toLocaleString()} 行，SHA-256 ${result.sha256}。`);
    } catch (error) {
      const recovered = await loadBackupJob().catch(() => undefined);
      if (recovered?.checkpointVersion === BACKUP_CHECKPOINT_VERSION) setJob(cloneBackupJob(recovered));
      setNotice(error instanceof Error ? error.message : "浏览器完整文件回读校验失败");
    } finally { setBusy(false); }
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

  async function deleteLocalBackup() {
    if (!localDataPresent || !window.confirm("确认删除此浏览器中的完整备份、分块和全部续传进度？此操作不会修改正式 D1。")) return;
    setBusy(true);
    try {
      await clearBackupStorage();
      setJob(null); setLocalStoredBytes(0); setLocalDataPresent(false); setStorageProblem("");
      setNotice("已删除此浏览器中的本地备份和续传数据；正式 D1 未被修改。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "删除浏览器本地备份失败"); }
    finally { setBusy(false); }
  }

  const running = job?.status === "running";
  const resumable = job?.status === "paused" && !storageProblem;
  const downloadable = job?.status === "complete" || job?.status === "invalid";
  const progress = job ? Math.min(100, Math.round(((job.phase === "export" ? 0 : 25) + job.tableIndex) / 50 * 100)) : 0;

  return <div className="stack-md">
    <section className="callout warning"><strong>Site v30 备份中心候选（未部署）</strong><p>正式 D1 只读。每页都从最后一个不可变检查点计算独立 nextJob 和 nextChunks，并在同一个 IndexedDB 事务中提交；事务成功后才推进内存与界面。生产恢复与单请求全库下载保持禁用。</p></section>
    <section className="callout warning"><strong>本地敏感数据提示</strong><p>浏览器本地备份包含全部业务数据，以及仅作为不透明加密密文保存的 Telegram Session；不会解密或显示 Session。当前占用 {formatBytes(localStoredBytes)}。下载与整文件回读会使用 getAll() + Blob，超过 {formatBytes(BACKUP_WHOLE_FILE_MEMORY_LIMIT_BYTES)} 将被阻止，以避免浏览器内存耗尽。</p></section>
    {storageProblem && <section className="notice error">{storageProblem}</section>}
    <section className="metric-grid"><article className="metric"><span>业务表</span><strong>{inventory?.tableCount ?? "—"}</strong><small>必须完整等于 25</small></article><article className="metric"><span>总行数</span><strong>{inventory ? inventory.totalRows.toLocaleString() : "—"}</strong><small>Schema + COUNT 合计 {inventory?.queryCount ?? "—"} 次查询</small></article><article className="metric"><span>本地占用</span><strong>{formatBytes(localStoredBytes)}</strong><small>备份分块与 footer 实际 UTF-8 字节</small></article><article className="metric"><span>候选版本</span><strong>v30</strong><small>正式仍为 Site v26</small></article></section>
    {job && <section className={`card operation-progress-card${job.status === "invalid" ? " failed" : ""}`}><div className="operation-progress-heading"><div><span className="eyebrow">浏览器本地原子检查点</span><h3>{job.status === "complete" ? "双遍复核完成" : job.status === "invalid" ? "文件已判定无效" : job.phase === "export" ? "第一遍导出" : job.phase === "verify" ? "第二遍复核" : "最终校验"}</h3></div><span className="operation-progress-percent">{progress}%</span></div><progress max={100} value={progress} /><div className="operation-progress-metrics"><span>{job.exportedRows.toLocaleString()} 行已写入本地分块</span><span>{job.requestCount} 个请求</span><span>单请求最多 {job.maxQueries} 次查询</span><span>{formatBytes(job.storedBytes)}</span><span>{job.status === "paused" ? "可从完整检查点续传" : job.status === "invalid" ? job.error : job.validationSha256 ? `文件校验 ${job.validationSha256.slice(0, 12)}…` : "job + chunks 原子提交"}</span></div></section>}
    <section className="card"><div className="section-heading"><div><span className="eyebrow">只读表清单</span><h3>合并 Schema 与 COUNT 统计</h3></div><div className="button-row"><button disabled={busy || running} onClick={() => void loadInventory()}>重新统计</button><button className="primary" disabled={busy || running || Boolean(storageProblem)} onClick={() => void startBackup()}>开始新备份</button>{running && <button onClick={pauseBackup}>安全暂停</button>}{resumable && <button className="primary" onClick={() => void resumeBackup()}>继续备份</button>}<button disabled={job?.status !== "complete" || busy} onClick={() => void validateStoredBackup()}>回读校验浏览器备份</button><button disabled={!downloadable || busy} onClick={() => void downloadBackup()}>{job?.status === "invalid" ? "下载无效证据文件" : "下载完整备份"}</button><button className="danger" disabled={!localDataPresent || running || busy} onClick={() => void deleteLocalBackup()}>删除本地备份和续传数据</button></div></div><p className="subtle">页面打开只执行 2 次查询，不读取全部业务行。每个分页请求固定 2 次查询，最多 {DATABASE_BACKUP_PAGE_MAX_ROWS} 行且目标不超过 {(DATABASE_BACKUP_PAGE_MAX_UTF8_BYTES / 1024).toLocaleString()} KiB；D1 bookmark 在请求间单调延续，第一遍与第二遍的逐表 SHA-256 必须完全一致。</p><div className="backup-table-scroll"><table className="sheet"><thead><tr><th>表</th><th>行数</th><th>稳定主键</th></tr></thead><tbody>{inventory?.tables.map((table) => <tr key={table.name}><td className="strong-cell">{table.name}</td><td>{table.rowCount.toLocaleString()}</td><td>{table.primaryKey.join(", ")}</td></tr>)}</tbody></table></div></section>
    <section className="card"><span className="eyebrow">只读文件校验</span><h3>选择完整备份 NDJSON</h3><p className="subtle">流式复算 25 表、Schema、分页顺序、行数、逐表 SHA-256、总清单 SHA-256、双遍完成标记与首尾 bookmark；服务端只用 1 次 Schema 查询且不写 D1。</p><label className="dropzone"><input type="file" accept="application/x-ndjson,.ndjson" disabled={busy || running} onChange={(event) => void validateFile(event.target.files?.[0])} /><strong>{fileName || "选择备份文件"}</strong><span>NDJSON · owner-only · 无生产恢复入口</span></label></section>
    <section className="callout"><strong>一致性与回滚边界</strong><p>分页或 footer 的本地事务失败时，nextJob 会被丢弃，并重新读取最后一个完整检查点；footer 未与 complete 状态原子落盘前，任务不会显示完成。正式迁移前仍必须另行记录 D1 Time Travel bookmark；本候选不会执行迁移、恢复或 0006。</p></section>
    {notice && <section className="notice">{notice}</section>}
  </div>;
}

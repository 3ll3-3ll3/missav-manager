"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canonicalMigrationRecord,
  validateMigrationRecord,
} from "../../lib/migration";
import { parseCsvRows } from "../../lib/rules";
import type { SanitizedImportRecord } from "../../lib/types";

type ConflictCase = "new" | "duplicate_exact" | "conflict";
type ServerItem = {
  tool: string;
  recordKey: string;
  primaryValue: string;
  case: ConflictCase;
  existing?: Record<string, unknown>;
};
type Rejection = { row: number; reason: string; identity: string };
type Preview = {
  fileName: string;
  checksum: string;
  total: number;
  records: SanitizedImportRecord[];
  rejections: Rejection[];
  toolCounts: Record<string, number>;
  serverCounts: Record<string, number>;
  serverItems: ServerItem[];
  inputExact: number;
  inputConflicts: number;
};
type Batch = {
  id: string;
  file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  rejected_rows: number;
  applied_rows: number;
  created_at: string;
  counts_json: string;
};

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
async function checksum(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function parseContent(
  name: string,
  text: string,
): Array<Record<string, unknown>> {
  if (name.toLowerCase().endsWith(".json")) {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (Array.isArray(object.records))
        return object.records as Array<Record<string, unknown>>;
      if (Array.isArray(object.rows))
        return object.rows as Array<Record<string, unknown>>;
    }
    throw new Error("JSON 必须是数组，或包含 records / rows 数组");
  }
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows
    .slice(1)
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      ),
    );
}

export default function MigrationPanel({
  onChanged,
}: {
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [strategy, setStrategy] = useState<"skip_conflicts" | "overwrite">(
    "skip_conflicts",
  );
  const load = useCallback(async () => {
    try {
      const payload = await api("/api/migrations");
      setBatches(payload.batches);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取批次失败");
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setNotice("");
    setBusy(true);
    try {
      if (/\.(sqlite|sqlite3|db|wal|shm)$/i.test(file.name))
        throw new Error(
          "禁止直接导入 SQLite、WAL 或 SHM；请先从桌面端导出脱敏 JSON/CSV。",
        );
      if (!/\.(json|csv)$/i.test(file.name))
        throw new Error("只接受脱敏 JSON 或 CSV");
      if (file.size > 100 * 1024 * 1024)
        throw new Error("文件超过 100 MB，请从桌面端分卷导出");
      const text = await file.text();
      const raw = parseContent(file.name, text);
      const rejections: Rejection[] = [];
      const accepted = new Map<
        string,
        { record: SanitizedImportRecord; canonical: string }
      >();
      let inputExact = 0,
        inputConflicts = 0;
      raw.forEach((source, index) => {
        const checked = validateMigrationRecord(source);
        const identity = String(
          source.recordKey ??
            source.normalizedValue ??
            source.primaryValue ??
            source.code ??
            "",
        );
        if (!checked.record) {
          rejections.push({
            row: index + 1,
            reason: checked.reason || "坏行",
            identity,
          });
          return;
        }
        const key = `${checked.record.tool}:${checked.record.recordKey}`;
        const canonical = canonicalMigrationRecord(checked.record);
        const prior = accepted.get(key);
        if (prior) {
          if (prior.canonical === canonical) {
            inputExact += 1;
            rejections.push({
              row: index + 1,
              reason: "文件内完全重复",
              identity: key,
            });
          } else {
            inputConflicts += 1;
            rejections.push({
              row: index + 1,
              reason: "文件内同一唯一键字段冲突（保留首次出现）",
              identity: key,
            });
          }
          return;
        }
        accepted.set(key, { record: checked.record, canonical });
      });
      const records = [...accepted.values()].map((item) => item.record);
      if (!records.length) throw new Error("文件没有可导入记录");
      const serverItems: ServerItem[] = [];
      const serverCounts: Record<string, number> = {};
      for (let offset = 0; offset < records.length; offset += 100) {
        const result = await api("/api/migrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "preview",
            records: records.slice(offset, offset + 100),
          }),
        });
        serverItems.push(...result.items);
        for (const [key, value] of Object.entries(
          result.counts as Record<string, number>,
        ))
          serverCounts[key] = (serverCounts[key] || 0) + value;
        setNotice(
          `正在与网站数据库核对 ${Math.min(offset + 100, records.length).toLocaleString()} / ${records.length.toLocaleString()}`,
        );
      }
      const toolCounts = records.reduce<Record<string, number>>(
        (counts, item) => ({
          ...counts,
          [item.tool]: (counts[item.tool] || 0) + 1,
        }),
        {},
      );
      setPreview({
        fileName: file.name,
        checksum: await checksum(text),
        total: raw.length,
        records,
        rejections,
        toolCounts,
        serverCounts,
        serverItems: serverItems.slice(0, 100),
        inputExact,
        inputConflicts,
      });
      setNotice(
        "预览完成：浏览器坏行检查与服务端现有库冲突核对均已完成，尚未写入。",
      );
    } catch (error) {
      setPreview(null);
      setNotice(error instanceof Error ? error.message : "无法读取文件");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || !preview.records.length) return;
    const conflictCount = preview.serverCounts.conflict || 0;
    if (
      strategy === "overwrite" &&
      !window.confirm(
        `将覆盖网站中 ${conflictCount.toLocaleString()} 条冲突记录。系统会先建立完整恢复点，是否继续？`,
      )
    )
      return;
    if (
      strategy === "skip_conflicts" &&
      !window.confirm(
        `将新增记录并跳过 ${conflictCount.toLocaleString()} 条冲突及完全重复项，是否继续？`,
      )
    )
      return;
    setBusy(true);
    try {
      const started = await api("/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start",
          fileName: preview.fileName,
          checksum: preview.checksum,
          totalRows: preview.total,
          validRows: preview.records.length,
          rejectedRows: preview.rejections.length,
          counts: {
            ...preview.toolCounts,
            ...preview.serverCounts,
            inputExact: preview.inputExact,
            inputConflicts: preview.inputConflicts,
          },
          strategy,
        }),
      });
      const chunks = [];
      for (let offset = 0; offset < preview.records.length; offset += 40)
        chunks.push(preview.records.slice(offset, offset + 40));
      let applied = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const result = await api("/api/migrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "append",
            batchId: started.batchId,
            chunkIndex: index,
            chunkChecksum: await checksum(JSON.stringify(chunk)),
            records: chunk,
          }),
        });
        applied += Number(result.appended || 0);
        setNotice(
          `服务端校验并写入分块 ${index + 1} / ${chunks.length} · 已应用 ${applied.toLocaleString()} 条`,
        );
      }
      await api("/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          batchId: started.batchId,
          expectedChunks: chunks.length,
          expectedRows: preview.records.length,
        }),
      });
      setNotice(
        `脱敏导入完成：服务端复核 ${chunks.length} 个分块，实际应用 ${applied.toLocaleString()} 条；可按批次回滚或使用完整恢复点。`,
      );
      setPreview(null);
      void load();
      onChanged();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "导入失败；批次保持可续传/可回滚状态",
      );
    } finally {
      setBusy(false);
    }
  }

  async function rollback(batch: Batch) {
    if (
      !window.confirm(
        `回滚“${batch.file_name}”批次？导入后又被修改的记录会停止自动回滚，避免覆盖新编辑。`,
      )
    )
      return;
    setBusy(true);
    try {
      await api("/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rollback-start", batchId: batch.id }),
      });
      let remaining = 1;
      while (remaining > 0) {
        const step = await api("/api/migrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "rollback-step", batchId: batch.id }),
        });
        remaining = step.remaining;
        setNotice(`正在回滚，剩余 ${remaining.toLocaleString()} 项`);
      }
      setNotice("批次已完整回滚");
      void load();
      onChanged();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "回滚失败；可改用迁移前完整恢复点",
      );
    } finally {
      setBusy(false);
    }
  }

  const countSummary = useMemo(
    () =>
      preview
        ? Object.entries(preview.toolCounts)
            .map(([key, value]) => `${key} ${value}`)
            .join(" · ")
        : "",
    [preview],
  );
  return (
    <div className="stack-lg">
      <section className="callout warning">
        <strong>先脱敏，再迁移</strong>
        <p>
          这里不接受
          SQLite、会话、密钥或原始浏览器数据。浏览器先解析坏行，服务器再核对现有库冲突；确认后逐块校验
          SHA-256、事务写入，并保留批次回滚与完整恢复点。
        </p>
      </section>
      <section className="migration-grid">
        <div className="card">
          <span className="eyebrow">步骤 1</span>
          <h3>选择脱敏文件</h3>
          <label className="dropzone large">
            <input type="file" accept=".json,.csv" onChange={selectFile} />
            <strong>{busy ? "正在解析与核对…" : "选择 JSON / CSV"}</strong>
            <span>不会在选择后自动写入</span>
          </label>
          <div className="format-note">
            <strong>最小字段</strong>
            <code>tool, recordKey, primaryValue</code>
            <p>也兼容 normalizedValue、primaryUrl、code、status 和三类标签。</p>
          </div>
        </div>
        <div className="card">
          <span className="eyebrow">步骤 2</span>
          <h3>预览、冲突与覆盖策略</h3>
          {preview ? (
            <>
              <div className="migration-metrics">
                <div>
                  <strong>{preview.total.toLocaleString()}</strong>
                  <span>原始行</span>
                </div>
                <div>
                  <strong>{preview.records.length.toLocaleString()}</strong>
                  <span>唯一有效</span>
                </div>
                <div>
                  <strong>{preview.rejections.length.toLocaleString()}</strong>
                  <span>坏行/文件重复</span>
                </div>
                <div>
                  <strong>
                    {(preview.serverCounts.new || 0).toLocaleString()}
                  </strong>
                  <span>网站新增</span>
                </div>
                <div>
                  <strong>
                    {(
                      preview.serverCounts.duplicate_exact || 0
                    ).toLocaleString()}
                  </strong>
                  <span>网站完全重复</span>
                </div>
                <div>
                  <strong>
                    {(preview.serverCounts.conflict || 0).toLocaleString()}
                  </strong>
                  <span>网站字段冲突</span>
                </div>
              </div>
              <p className="checksum" title={preview.checksum}>
                原文件 SHA-256 · {preview.checksum}
              </p>
              <p className="hint">
                {countSummary} · 文件内完全重复 {preview.inputExact} ·
                文件内冲突 {preview.inputConflicts}
              </p>
              <label className="field">
                <span>字段冲突策略</span>
                <select
                  value={strategy}
                  onChange={(event) =>
                    setStrategy(
                      event.target.value as "skip_conflicts" | "overwrite",
                    )
                  }
                >
                  <option value="skip_conflicts">跳过冲突（推荐）</option>
                  <option value="overwrite">
                    用迁移文件覆盖，并保留恢复点
                  </option>
                </select>
              </label>
              <div className="preview-rows">
                {preview.serverItems.slice(0, 40).map((item, index) => (
                  <div key={`${item.tool}-${item.recordKey}`}>
                    <span>{index + 1}</span>
                    <span className={`tool-chip ${item.tool}`}>
                      {item.tool}
                    </span>
                    <strong>{item.primaryValue}</strong>
                    <small>{item.case}</small>
                  </div>
                ))}
              </div>
              {preview.rejections.length > 0 && (
                <details className="rejection-list">
                  <summary>
                    查看坏行与文件内重复原因（{preview.rejections.length}）
                  </summary>
                  {preview.rejections.slice(0, 100).map((item) => (
                    <p key={`${item.row}-${item.reason}`}>
                      第 {item.row} 行 · {item.reason}
                      {item.identity ? ` · ${item.identity}` : ""}
                    </p>
                  ))}
                </details>
              )}
              <button className="primary wide" disabled={busy} onClick={apply}>
                {busy
                  ? "处理中…"
                  : `确认导入 ${preview.records.length.toLocaleString()} 条`}
              </button>
            </>
          ) : (
            <div className="empty compact">
              <strong>尚未选择文件</strong>
              <p>选择后会显示坏行、完全重复、冲突和覆盖范围。</p>
            </div>
          )}
        </div>
      </section>
      {notice && <div className="notice">{notice}</div>}
      <section className="card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">步骤 3</span>
            <h3>迁移批次与回滚</h3>
          </div>
          <button onClick={() => void load()}>刷新</button>
        </div>
        <div className="batch-list">
          {batches.map((batch) => (
            <div key={batch.id}>
              <div>
                <strong>{batch.file_name}</strong>
                <small>
                  {new Date(batch.created_at).toLocaleString("zh-CN")} · 原始{" "}
                  {batch.total_rows.toLocaleString()} · 写入{" "}
                  {batch.applied_rows.toLocaleString()} · 拒绝{" "}
                  {batch.rejected_rows.toLocaleString()}
                </small>
              </div>
              <span className={`batch-status ${batch.status}`}>
                {batch.status}
              </span>
              {["applied", "importing"].includes(batch.status) && (
                <button disabled={busy} onClick={() => rollback(batch)}>
                  回滚
                </button>
              )}
            </div>
          ))}
          {!batches.length && (
            <div className="empty compact">
              <strong>暂无迁移批次</strong>
              <p>每次确认导入都会保存批次、分块校验和恢复记录。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

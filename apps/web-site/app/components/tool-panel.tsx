"use client";

import { useMemo, useState } from "react";
import { parseCsvRows, processDocuments } from "../../lib/rules";
import type { InputDocument } from "../../lib/rules";
import type { ToolId, ToolResult } from "../../lib/types";
import { csvSafe, safeHttpUrl } from "../../lib/security";
import ErrorNotice, { toUiError, type UiError } from "./error-notice";
import HistoryPanel from "./history-panel";
import MissavScriptPanel from "./missav-script-panel";
import ResultTable from "./result-table";
import TelegramPanel from "./telegram-panel";

export const TOOL_DEFINITIONS: Array<{
  id: ToolId;
  mark: string;
  title: string;
  note: string;
}> = [
  { id: "twitter", mark: "#", title: "Twitter", note: "标签、@账号与个人页" },
  { id: "badnews", mark: "B", title: "Bad.news", note: "主题链接规范化" },
  { id: "haijiao", mark: "海", title: "海角", note: "限定分类与数字页面" },
  { id: "missav", mark: "AV", title: "MissAV", note: "番号、脚本与两层黑名单" },
  { id: "av123", mark: "123", title: "123AV", note: "本地任务与结果回填" },
];

const STAGES = [
  ["input", "1 输入"],
  ["telegram", "2 Telegram 消息"],
  ["results", "3 结果"],
  ["execute", "4 执行/导出"],
  ["history", "5 历史"],
] as const;
type Stage = (typeof STAGES)[number][0];

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function download(name: string, content: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function ToolPanel({
  tool,
  onSaved,
  onOpenTelegramSettings,
  onBack,
}: {
  tool: ToolId;
  onSaved: () => void;
  onOpenTelegramSettings: (tool: ToolId) => void;
  onBack: () => void;
}) {
  const [stage, setStage] = useState<Stage>("input");
  const [paste, setPaste] = useState("");
  const [files, setFiles] = useState<InputDocument[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [results, setResults] = useState<ToolResult[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const active = TOOL_DEFINITIONS.find((item) => item.id === tool)!;
  const documents = useMemo(
    () => [...(paste.trim() ? [{ name: "粘贴文本", text: paste }] : []), ...files],
    [paste, files],
  );
  const chosen = selected.size ? results.filter((item) => selected.has(item.resultKey)) : results;

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = [...(event.target.files || [])];
    event.target.value = "";
    const invalid = picked.find((file) => !/\.(txt|html?|md|json|csv|log)$/i.test(file.name) || file.size > 20 * 1024 * 1024);
    if (invalid || picked.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      setError({ summary: invalid ? `文件 ${invalid.name} 类型不受支持或超过 20 MB` : "一次选择的文件总量超过 50 MB" });
      return;
    }
    const loaded = await Promise.all(
      picked.map(async (file) => ({ name: file.name, text: await file.text() })),
    );
    setFiles((current) => [...current, ...loaded]);
  }

  function run() {
    try {
      if (!documents.length) throw new Error("请粘贴文本或添加文件");
      const output = processDocuments(tool, documents, start, end);
      setResults(output.results);
      setMessageCount(output.messages.length);
      setSelected(new Set());
      setError(null);
      setNotice(`已从 ${output.messages.length} 条消息提取 ${output.results.length} 条结果`);
      setStage("results");
    } catch (reason) {
      setError(toUiError(reason, "规则处理失败"));
    }
  }

  async function save() {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const result = await api("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, name: `${active.title} · ${new Date().toLocaleString("zh-CN")}`, inputKind: files.length ? "files" : "manual", startAt: start, endAt: end, sourceSummary: documents.map((item) => item.name).join(", "), results: chosen }),
      });
      setNotice(result.overwriteSnapshotId ? `已保存 ${result.resultCount} 条；覆盖旧记录前恢复点 ${String(result.overwriteSnapshotId).slice(0, 8)}… 已建立` : `已保存 ${result.resultCount} 条到历史和数据中心`);
      setError(null);
      onSaved();
    } catch (reason) {
      setError(toUiError(reason, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  function plain() {
    return chosen.map((item) => item.secondaryValue ? `${item.primaryValue}\t${item.secondaryValue}` : item.primaryValue).join("\r\n");
  }

  function exportResults(format: "txt" | "csv" | "json") {
    if (!chosen.length) return;
    if (format === "txt") download(`${tool}-results.txt`, plain());
    else if (format === "json") download(`${tool}-results.json`, JSON.stringify({ tool, exportedAt: new Date().toISOString(), count: chosen.length, results: chosen }, null, 2), "application/json");
    else download(`${tool}-results.csv`, `\uFEFF${[["primary", "secondary", "status", "source"].map(csvSafe).join(","), ...chosen.map((row) => [row.primaryValue, row.secondaryValue, row.status, row.source].map(csvSafe).join(","))].join("\r\n")}`, "text/csv;charset=utf-8");
  }

  async function raindrop(kind: "csv" | "html" | "report") {
    try {
      const payload = await api("/api/raindrop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: kind === "html" ? "html" : "csv", results: chosen }) });
      if (kind === "report") download("raindrop-exclusion-report.json", JSON.stringify({ generatedAt: new Date().toISOString(), included: payload.included, excluded: payload.excluded, records: payload.audits }, null, 2), "application/json");
      else download(`raindrop-missav.${kind}`, payload.content, kind === "html" ? "text/html;charset=utf-8" : "text/csv;charset=utf-8");
      setNotice(`Raindrop：包含 ${payload.included}，排除 ${payload.excluded}`);
    } catch (reason) {
      setError(toUiError(reason, "Raindrop 导出失败"));
    }
  }

  async function importAv123(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (!/\.csv$/i.test(file.name) || file.size > 10 * 1024 * 1024) throw new Error("123AV 结果只接受不超过 10 MB 的 CSV");
      const rows = parseCsvRows(await file.text());
      if (rows.length < 2) throw new Error("结果 CSV 没有数据");
      const headers = rows[0].map((value) => value.trim().toLowerCase());
      const find = (...names: string[]) => headers.findIndex((value) => names.includes(value));
      const codeIndex = find("code", "番号", "primary", "primary_value");
      const statusIndex = find("status", "状态");
      const urlIndex = find("url", "av123_url", "123av_url");
      if (codeIndex < 0) throw new Error("结果 CSV 缺少 code/番号列");
      const map = new Map(rows.slice(1).map((row) => [String(row[codeIndex] || "").toUpperCase().replaceAll("_", "-"), { status: String(row[statusIndex] || "result_imported").slice(0, 64), url: safeHttpUrl(row[urlIndex] || "") }]));
      let updated = 0;
      setResults((current) => current.map((item) => { const hit = map.get(item.primaryValue); if (!hit) return item; updated += 1; return { ...item, status: hit.status, secondaryValue: hit.url || item.secondaryValue, metadata: { ...item.metadata, av123ResultImported: true } }; }));
      setNotice(`已回填 ${updated} 条 123AV 本地结果；保存后持久化`);
      setStage("results");
    } catch (reason) {
      setError(toUiError(reason, "123AV 结果导入失败"));
    }
  }

  return (
    <div className="stack-lg tool-workspace-five-stage">
      <section className="tool-workspace-heading card"><button onClick={onBack}>← 工具首页</button><div className="tool-identity"><span>{active.mark}</span><div><span className="eyebrow">独立工具工作区</span><h2>{active.title}</h2><p>{active.note}</p></div></div><span className="pill">Windows v0.5.13 语义</span></section>
      <nav className="stage-tabs" aria-label={`${active.title} 五阶段`}>{STAGES.map(([id, label]) => <button key={id} className={stage === id ? "active" : ""} onClick={() => setStage(id)}><span>{label.split(" ")[0]}</span>{label.split(" ").slice(1).join(" ")}</button>)}</nav>
      {notice && <div className="notice">{notice}</div>}
      {error && <ErrorNotice error={error} retry={() => setError(null)} />}

      {stage === "input" && <section className="card tool-stage-card"><div className="section-heading"><div><span className="eyebrow">1 输入</span><h3>{active.title} 内容</h3></div><span className="subtle">输入与其他工具隔离</span></div><label className="field"><span>粘贴文本</span><textarea rows={14} value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="粘贴 Telegram 导出片段、普通文本或链接…" /></label><label className="dropzone"><input type="file" multiple accept=".txt,.html,.htm,.md,.json,.csv,.log" onChange={pick} /><strong>＋ 添加导出文件</strong><span>TXT · HTML · JSON · CSV · LOG</span></label>{files.length > 0 && <div className="file-list">{files.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}<button aria-label="移除" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}</div>}<div className="date-grid"><label className="field"><span>开始时间</span><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label className="field"><span>结束时间</span><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div><div className="button-row"><button className="primary" onClick={run}>运行 v0.5.13 规则</button><button onClick={() => setStage("telegram")}>改用 Telegram 消息</button></div><p className="hint">时间筛选只作用于带时间戳的 Telegram HTML/JSON；普通文本始终参与。</p></section>}

      {stage === "telegram" && <TelegramPanel tool={tool} onProcessed={() => { onSaved(); setNotice("Telegram 队列处理完成，可到历史查看结果"); }} onOpenTelegramSettings={() => onOpenTelegramSettings(tool)} />}

      {stage === "results" && <div className="stack-md"><section className="tool-stage-summary card"><div><span className="eyebrow">3 结果</span><h3>{results.length.toLocaleString()} 条结果</h3></div><span>{messageCount.toLocaleString()} 条输入消息</span><button onClick={() => setStage("execute")}>继续执行 / 导出 →</button></section><ResultTable tool={tool} results={results} setResults={setResults} selected={selected} setSelected={setSelected} notice={setNotice} /></div>}

      {stage === "execute" && <div className="stack-md"><section className="card tool-stage-card"><div className="section-heading"><div><span className="eyebrow">4 执行 / 导出</span><h3>{selected.size ? `所选 ${chosen.length} 条` : `全部 ${chosen.length} 条`}</h3></div><button onClick={() => setStage("results")}>返回选择结果</button></div><div className="execution-grid"><article><strong>保存到网站</strong><p>写入 D1 历史和数据中心；覆盖旧记录前自动建立恢复点。</p><button className="primary" disabled={!chosen.length || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存历史与数据"}</button></article><article><strong>通用导出</strong><p>云端 D1 与 Windows SQLite 独立，只统一字段与导出格式。</p><div className="button-row"><button disabled={!chosen.length} onClick={() => exportResults("txt")}>TXT</button><button disabled={!chosen.length} onClick={() => exportResults("csv")}>{tool === "av123" ? "任务 CSV" : "CSV"}</button><button disabled={!chosen.length} onClick={() => exportResults("json")}>JSON</button></div></article>{tool === "av123" && <article><strong>123AV 本地回填</strong><p>导出任务给 Windows，完成后导入结果 CSV；网络错误保留为 network_error。</p><label className="file-button"><input type="file" accept=".csv" onChange={importAv123} />导入本地结果 CSV</label></article>}{tool === "missav" && <article><strong>Raindrop 与黑名单</strong><p>预览和导出继续共用第二层黑名单，并保留排除审计。</p><div className="button-row"><button disabled={!chosen.length} onClick={() => void raindrop("csv")}>Raindrop CSV</button><button disabled={!chosen.length} onClick={() => void raindrop("html")}>书签 HTML</button><button disabled={!chosen.length} onClick={() => void raindrop("report")}>排除报告</button></div></article>}</div></section>{tool === "missav" && <MissavScriptPanel results={chosen} />}</div>}

      {stage === "history" && <div className="stack-md"><section className="tool-stage-summary card"><div><span className="eyebrow">5 历史</span><h3>{active.title} 历史</h3></div><span>只显示当前工具</span></section><HistoryPanel refreshKey={0} toolId={tool} /></div>}
    </div>
  );
}

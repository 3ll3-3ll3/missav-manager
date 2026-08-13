"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseCsvRows, processDocuments } from "../../lib/rules";
import type { InputDocument } from "../../lib/rules";
import { toolPlainText } from "../../lib/tool-output";
import type { ToolId, ToolResult } from "../../lib/types";
import { csvSafe, safeHttpUrl } from "../../lib/security";
import ErrorNotice, { toUiError, type UiError } from "./error-notice";
import HistoryPanel from "./history-panel";
import MissavScriptPanel from "./missav-script-panel";
import PlainOutputPanel from "./plain-output-panel";
import ResultTable from "./result-table";
import TelegramPanel, { type TelegramProcessResult } from "./telegram-panel";

export const TOOL_DEFINITIONS: Array<{ id: ToolId; mark: string; title: string; note: string }> = [
  { id: "twitter", mark: "#", title: "推特博主", note: "从 ASCII #标签、可信 @账号与 X/Twitter 主页提取博主" },
  { id: "badnews", mark: "B", title: "Bad.news", note: "只保留 bad.news/t/数字 的规范帖子直达链接" },
  { id: "haijiao", mark: "海", title: "海角帖子", note: "只保留七类栏目/数字.html 正文地址" },
  { id: "missav", mark: "AV", title: "MissAV", note: "规范番号、可信来源链接和完整浏览器脚本" },
  { id: "av123", mark: "123", title: "123AV", note: "番号本地任务、CSV 交接、结果导入和状态管理" },
];

type Stage = "input" | "results" | "script" | "local" | "history";
type UploadedFile = InputDocument & { size: number; error?: string };
type Av123Preview = { fileName: string; matched: number; unmatched: number; duplicates: number; badRows: number; updates: Map<string, { status: string; url: string }> };

const STAGES: Record<ToolId, Array<[Stage, string]>> = {
  twitter: [["input", "1 输入"], ["results", "2 结果"], ["history", "3 历史"]],
  badnews: [["input", "1 输入"], ["results", "2 结果"], ["history", "3 历史"]],
  haijiao: [["input", "1 输入"], ["results", "2 结果"], ["history", "3 历史"]],
  missav: [["input", "1 输入"], ["results", "2 结果"], ["script", "3 浏览器脚本"], ["history", "4 历史"]],
  av123: [["input", "1 输入"], ["results", "2 结果"], ["local", "3 本地任务"], ["history", "4 历史"]],
};

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

function av123Url(value: unknown) {
  const safe = safeHttpUrl(value);
  if (!safe) return "";
  try {
    const host = new URL(safe).hostname.toLowerCase().replace(/^www\./, "");
    return host === "123av.com" || host.endsWith(".123av.com") ? safe : "";
  } catch { return ""; }
}

function av123Status(value: unknown, hasUrl: boolean) {
  const text = String(value || "").trim().toLowerCase();
  if (["network_error", "网络异常", "网络错误"].includes(text)) return "network_error";
  if (["not_found", "未找到"].includes(text)) return "not_found";
  if (["verify_required", "manual", "待核验", "待复查"].includes(text)) return "verify_required";
  if (["pending", "task_ready", "待本地处理"].includes(text)) return "task_ready";
  return hasUrl || ["success", "succeeded", "result_imported", "已导入结果", "成功"].includes(text) ? "result_imported" : "verify_required";
}

export default function ToolPanel({ tool, requestedRun, onSaved, onOpenTelegramSettings, onOpenRuleLibrary, onBack }: { tool: ToolId; requestedRun?: { tool: ToolId; runId: string; nonce: number } | null; onSaved: () => void; onOpenTelegramSettings: (tool: ToolId) => void; onOpenRuleLibrary: () => void; onBack: () => void }) {
  const [stage, setStage] = useState<Stage>("input");
  const [inputMode, setInputMode] = useState<"manual" | "telegram">("manual");
  const [paste, setPaste] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [results, setResults] = useState<ToolResult[]>([]);
  const [filteredResults, setFilteredResults] = useState<ToolResult[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const [savedRunId, setSavedRunId] = useState("");
  const [resultsDirty, setResultsDirty] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [av123Preview, setAv123Preview] = useState<Av123Preview | null>(null);
  const [historyCount, setHistoryCount] = useState(0);
  const active = TOOL_DEFINITIONS.find((item) => item.id === tool)!;
  const documents = useMemo(() => [...(paste.trim() ? [{ name: "粘贴文本", text: paste }] : []), ...files.filter((file) => !file.error).map(({ name, text }) => ({ name, text }))], [paste, files]);
  const selectedResults = useMemo(() => results.filter((item) => selected.has(item.resultKey)), [results, selected]);
  const scope = selectedResults.length ? selectedResults : filteredResults;
  const setDraftResults: React.Dispatch<React.SetStateAction<ToolResult[]>> = (next) => { setResults(next); setResultsDirty(true); };

  const loadHistoryCount = useCallback(async () => {
    try { const payload = await api(`/api/runs?tool=${encodeURIComponent(tool)}&page=1&pageSize=10`); setHistoryCount(Number(payload.total || 0)); }
    catch { /* The workspace remains usable when the count badge cannot refresh. */ }
  }, [tool]);

  useEffect(() => { const timer = window.setTimeout(() => void loadHistoryCount(), 0); return () => window.clearTimeout(timer); }, [loadHistoryCount]);

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = [...(event.target.files || [])]; event.target.value = "";
    if (!picked.length) return;
    const totalBytes = picked.reduce((sum, file) => sum + file.size, 0);
    const loaded = await Promise.all(picked.map(async (file): Promise<UploadedFile> => {
      if (!/\.(txt|html?|md|json|csv|log)$/i.test(file.name)) return { name: file.name, text: "", size: file.size, error: "不支持的文件类型" };
      if (file.size > 20 * 1024 * 1024) return { name: file.name, text: "", size: file.size, error: "单文件超过 20 MB" };
      if (totalBytes > 50 * 1024 * 1024) return { name: file.name, text: "", size: file.size, error: "本次文件总量超过 50 MB" };
      try { return { name: file.name, text: await file.text(), size: file.size }; }
      catch { return { name: file.name, text: "", size: file.size, error: "浏览器读取失败" }; }
    }));
    setFiles((current) => [...current, ...loaded]);
  }

  async function saveRows(rows: ToolResult[], inputKind: string, sourceSummary: string) {
    const result = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, name: `${active.title} · ${new Date().toLocaleString("zh-CN")}`, inputKind, startAt: start, endAt: end, sourceSummary, results: rows }) });
    setSavedRunId(String(result.runId || "")); setResultsDirty(false); onSaved(); void loadHistoryCount(); return result;
  }

  async function extractAndSave() {
    if (!documents.length) { setError({ summary: "请粘贴文本或添加至少一个可读取文件" }); return; }
    setBusy(true); setError(null);
    try {
      const output = processDocuments(tool, documents, start, end);
      const succeeded = files.filter((item) => !item.error).length; const failed = files.filter((item) => item.error).length;
      const sourceSummary = `${documents.map((item) => item.name).join(", ")}；解析消息 ${output.messages.length}；文件成功 ${succeeded} / 失败 ${failed}`;
      const saved = await saveRows(output.results, files.length ? "manual_files" : "manual", sourceSummary);
      setResults(output.results); setFilteredResults(output.results); setMessageCount(output.messages.length); setSelected(new Set());
      setNotice(`事务式提取完成：文件成功 ${succeeded}，失败 ${failed}；解析 ${output.messages.length.toLocaleString()} 条消息，得到 ${output.results.length.toLocaleString()} 条结果，并已保存历史${saved.overwriteSnapshotId ? `；覆盖前恢复点 ${String(saved.overwriteSnapshotId).slice(0, 8)}…` : ""}`);
      setStage("results");
    } catch (reason) { setError(toUiError(reason, "提取和保存未完成；本次不会显示成已保存历史")); }
    finally { setBusy(false); }
  }

  async function saveEditedResults() {
    if (!scope.length) return; setBusy(true);
    try { const saved = await saveRows(scope, "edited_results", `从任务 ${savedRunId || "未保存草稿"} 编辑；范围 ${selectedResults.length ? "所选" : "当前筛选"}`); setNotice(`已把 ${saved.resultCount.toLocaleString()} 条修改保存为新历史${saved.overwriteSnapshotId ? `；恢复点 ${String(saved.overwriteSnapshotId).slice(0, 8)}…` : ""}`); }
    catch (reason) { setError(toUiError(reason, "修改结果保存失败")); }
    finally { setBusy(false); }
  }

  function exportResults(format: "txt" | "csv" | "json") {
    if (!scope.length) return;
    if (format === "txt") download(`${tool}-results.txt`, toolPlainText(tool, scope));
    else if (format === "json") download(`${tool}-results.json`, JSON.stringify({ tool, runId: savedRunId, exportedAt: new Date().toISOString(), count: scope.length, results: scope }, null, 2), "application/json");
    else download(`${tool}-results.csv`, `\uFEFF${[["primary", "secondary", "status", "tags", "source"].map(csvSafe).join(","), ...scope.map((row) => [row.primaryValue, row.secondaryValue, row.status, (row.tags || []).join("|"), row.source].map(csvSafe).join(","))].join("\r\n")}`, "text/csv;charset=utf-8");
    setNotice(`已按${selectedResults.length ? `所选 ${scope.length}` : `当前筛选 ${scope.length}`}条导出 ${format.toUpperCase()}`);
  }

  async function raindrop(kind: "csv" | "html" | "report") {
    try { const payload = await api("/api/raindrop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: kind === "html" ? "html" : "csv", results: scope }) }); if (kind === "report") download("raindrop-exclusion-report.json", JSON.stringify({ generatedAt: new Date().toISOString(), included: payload.included, excluded: payload.excluded, records: payload.audits }, null, 2), "application/json"); else download(`raindrop-missav.${kind}`, payload.content, kind === "html" ? "text/html;charset=utf-8" : "text/csv;charset=utf-8"); setNotice(`Raindrop 预览与文件共用同一规则：包含 ${payload.included}，排除 ${payload.excluded}`); }
    catch (reason) { setError(toUiError(reason, "Raindrop 导出失败")); }
  }

  function exportAv123Tasks(onlyExceptions = false) {
    const rows = scope.filter((row) => !onlyExceptions || ["network_error", "verify_required"].includes(String(row.status || "")));
    if (!rows.length) { setNotice("当前范围没有网络异常或待核验任务"); return; }
    const content = `\uFEFF${[["code", "url", "status", "task_id"].map(csvSafe).join(","), ...rows.map((row) => [row.primaryValue, row.secondaryValue || "", row.status || "task_ready", String(row.metadata?.taskId || savedRunId || row.resultKey)].map(csvSafe).join(","))].join("\r\n")}`;
    download(`123av-${onlyExceptions ? "exceptions" : "tasks"}.csv`, content, "text/csv;charset=utf-8"); setNotice(`已导出 ${rows.length.toLocaleString()} 条本地任务；网页没有执行查询或账号收藏`);
  }

  async function previewAv123Import(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try {
      if (!/\.csv$/i.test(file.name) || file.size > 10 * 1024 * 1024) throw new Error("结果只接受不超过 10 MB 的 CSV");
      const rows = parseCsvRows(await file.text()); if (rows.length < 2) throw new Error("结果 CSV 没有数据");
      const headers = rows[0].map((value) => value.trim().toLowerCase()); const find = (...names: string[]) => headers.findIndex((value) => names.includes(value));
      const codeIndex = find("code", "番号", "primary", "primary_value"); const statusIndex = find("status", "状态"); const urlIndex = find("url", "av123_url", "123av_url");
      if (codeIndex < 0) throw new Error("结果 CSV 缺少 code/番号列");
      const available = new Set(results.map((row) => row.primaryValue.toUpperCase().replaceAll("_", "-"))); const updates = new Map<string, { status: string; url: string }>();
      let badRows = 0; let duplicates = 0; let unmatched = 0;
      for (const row of rows.slice(1)) {
        const code = String(row[codeIndex] || "").trim().toUpperCase().replaceAll("_", "-");
        if (!code) { badRows += 1; continue; } if (updates.has(code)) { duplicates += 1; continue; } if (!available.has(code)) { unmatched += 1; continue; }
        const url = urlIndex >= 0 ? av123Url(row[urlIndex]) : ""; const rawUrl = urlIndex >= 0 ? String(row[urlIndex] || "").trim() : "";
        if (rawUrl && !url) { badRows += 1; continue; } updates.set(code, { url, status: av123Status(statusIndex >= 0 ? row[statusIndex] : "", Boolean(url)) });
      }
      setAv123Preview({ fileName: file.name, matched: updates.size, unmatched, duplicates, badRows, updates }); setNotice("导入仍处于预览状态；确认前不会写入任何结果");
    } catch (reason) { setError(toUiError(reason, "123AV 结果导入预览失败")); }
  }

  async function confirmAv123Import() {
    if (!av123Preview?.updates.size) return;
    const next = results.map((item) => { const hit = av123Preview.updates.get(item.primaryValue.toUpperCase().replaceAll("_", "-")); return hit ? { ...item, status: hit.status, secondaryValue: hit.url || item.secondaryValue, metadata: { ...item.metadata, av123ResultImported: true, importedAt: new Date().toISOString() } } : item; });
    setBusy(true);
    try { const saved = await saveRows(next, "av123_result_import", `${av123Preview.fileName}；匹配 ${av123Preview.matched}，未匹配 ${av123Preview.unmatched}，重复 ${av123Preview.duplicates}，坏行 ${av123Preview.badRows}`); setResults(next); setFilteredResults(next); setSelected(new Set()); setAv123Preview(null); setNotice(`已事务写入 ${saved.resultCount.toLocaleString()} 条 123AV 状态；Chrome 扩展、APP 内助手和账号收藏仍请使用 Windows v0.5.13`); }
    catch (reason) { setError(toUiError(reason, "123AV 结果事务写入失败")); }
    finally { setBusy(false); }
  }

  function receiveTelegramResults(result: TelegramProcessResult) {
    const next = Array.isArray(result.results) ? result.results : [];
    setResults(next); setFilteredResults(next); setMessageCount(result.selected); setSelected(new Set()); setSavedRunId(result.runId || ""); setResultsDirty(false);
    setNotice(result.resultCount ? `Telegram 处理完成并已保存历史：处理 ${result.selected} 条消息，提取 ${result.resultCount} 条结果` : `Telegram 处理完成并已保存历史：处理 ${result.selected} 条消息，本次正式记录为空结果；不会重新显示成未处理`); setStage("results"); onSaved(); void loadHistoryCount();
  }

  const loadHistoryRun = useCallback((detail: { runId: string; results: ToolResult[] }) => { setResults(detail.results); setFilteredResults(detail.results); setSelected(new Set()); setSavedRunId(detail.runId); setResultsDirty(false); setStage("results"); setNotice(`已载入历史任务 ${detail.runId.slice(0, 8)}…，结果、状态、标签、来源和元数据已恢复`); }, []);

  const loadRunById = useCallback(async (runId: string) => {
    const first = await api(`/api/runs?id=${encodeURIComponent(runId)}&resultPage=1&resultPageSize=500`);
    const pages = Math.max(1, Math.ceil(Number(first.total || 0) / 500));
    const rows = [...(first.results || [])] as Array<Record<string, unknown>>;
    for (let page = 2; page <= pages; page += 1) {
      const part = await api(`/api/runs?id=${encodeURIComponent(runId)}&resultPage=${page}&resultPageSize=500`);
      rows.push(...(part.results || []));
    }
    const parseList = (value: unknown) => { try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } };
    const parseObject = (value: unknown) => { try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } };
    return { runId, results: rows.map((row) => ({ resultKey: String(row.result_key || row.id || ""), primaryValue: String(row.primary_value || ""), secondaryValue: String(row.secondary_value || ""), status: String(row.status || ""), tags: parseList(row.tags_json), source: String(row.source || ""), metadata: parseObject(row.metadata_json) })) };
  }, []);

  useEffect(() => {
    if (savedRunId) localStorage.setItem(`tool-last-run:${tool}`, savedRunId);
  }, [savedRunId, tool]);

  useEffect(() => {
    const runId = localStorage.getItem(`tool-last-run:${tool}`) || "";
    if (!runId) return;
    let cancelled = false;
    void loadRunById(runId).then((detail) => { if (!cancelled) loadHistoryRun(detail); }).catch(() => {
      localStorage.removeItem(`tool-last-run:${tool}`);
    });
    return () => { cancelled = true; };
  }, [tool, loadRunById, loadHistoryRun]);

  useEffect(() => {
    if (!requestedRun?.runId || requestedRun.tool !== tool) return;
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await loadRunById(requestedRun.runId);
        if (cancelled) return;
        loadHistoryRun(detail);
      } catch (reason) { if (!cancelled) setError(toUiError(reason, "处理中心任务载入失败")); }
    };
    void load();
    return () => { cancelled = true; };
  }, [requestedRun, tool, loadHistoryRun, loadRunById]);

  return <div className="stack-lg tool-workspace">
    <section className="tool-workspace-heading card"><button onClick={onBack}>← 工具首页</button><div className="tool-identity"><span>{active.mark}</span><div><span className="eyebrow">独立工具工作区</span><h2>{active.title}</h2><p>{active.note}</p></div></div><div className="tool-workspace-badges"><span className="pill">历史 {historyCount.toLocaleString()} 条</span><span className="pill">{savedRunId ? `当前任务 ${savedRunId.slice(0, 8)}…` : "尚未载入任务"}</span></div></section>
    <nav className="stage-tabs" style={{ gridTemplateColumns: `repeat(${STAGES[tool].length}, minmax(0, 1fr))` }} aria-label={`${active.title} 工作阶段`}>{STAGES[tool].map(([id, label]) => <button key={id} className={stage === id ? "active" : ""} onClick={() => setStage(id)}><span>{label.split(" ")[0]}</span>{label.split(" ").slice(1).join(" ")}</button>)}</nav>
    {notice && <div className="notice">{notice}</div>}{error && <ErrorNotice error={error} retry={() => setError(null)} />}

    {stage === "input" && <div className="stack-md"><nav className="input-mode-tabs"><button className={inputMode === "manual" ? "active" : ""} onClick={() => setInputMode("manual")}><strong>手动 / 文件</strong><span>粘贴与多文件解析</span></button><button className={inputMode === "telegram" ? "active" : ""} onClick={() => setInputMode("telegram")}><strong>Telegram 消息</strong><span>复用全局连接与检查点</span></button></nav>{inputMode === "manual" ? <section className="card tool-stage-card"><div className="section-heading"><div><span className="eyebrow">1 输入 · 手动 / 文件</span><h3>{active.title} 内容</h3></div><span className="subtle">成功文件独立保留，单文件失败不会丢掉其他文件</span></div><label className="field"><span>粘贴文本</span><textarea rows={12} value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="粘贴 Telegram 导出片段、普通文本、链接或番号…" /></label><label className="dropzone"><input type="file" multiple accept=".txt,.html,.htm,.md,.json,.csv,.log" onChange={pick} /><strong>＋ 一次选择多个文件</strong><span>TXT · HTML · HTM · MD · JSON · CSV · LOG</span></label>{files.length > 0 && <div className="parsed-file-list">{files.map((file, index) => <article key={`${file.name}-${index}`} className={file.error ? "failed" : "success"}><div><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KB · {file.error || `${file.text.length.toLocaleString()} 字符 · 读取成功`}</small></div><button onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></article>)}</div>}<div className="date-grid"><label className="field"><span>开始时间（精确到分钟）</span><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label className="field"><span>结束时间（精确到分钟）</span><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div><button className="primary wide" disabled={busy || !documents.length} onClick={() => void extractAndSave()}>{busy ? "提取并保存中…" : "提取并保存历史"}</button><p className="hint">这一个按钮完成解析、规则提取、任务和结果保存；失败不会显示为已保存。时间筛选只作用于带时间戳的 Telegram HTML/JSON。</p></section> : <TelegramPanel tool={tool} onProcessed={receiveTelegramResults} onOpenTelegramSettings={() => onOpenTelegramSettings(tool)} />}</div>}

    {stage === "results" && <div className="stack-md"><section className="tool-stage-summary card"><div><span className="eyebrow">2 结果</span><h3>{results.length.toLocaleString()} 条结构化结果</h3><p className="stage-purpose">纯文本和表格使用同一筛选范围；有选择时按所选操作，没有选择时按当前筛选操作。</p></div><div className="result-stage-actions"><span>{messageCount.toLocaleString()} 条输入消息</span><span className={`result-save-state ${savedRunId && !resultsDirty ? "saved" : "draft"}`}>{savedRunId && !resultsDirty ? "结果与历史已保存" : "结果有未保存修改"}</span>{tool === "missav" && <button className="primary" disabled={!scope.length} onClick={() => setStage("script")}>进入浏览器脚本 →</button>}{tool === "av123" && <button className="primary" disabled={!scope.length} onClick={() => setStage("local")}>进入本地任务 →</button>}</div></section><PlainOutputPanel tool={tool} filtered={filteredResults} selected={selectedResults} notice={setNotice} /><section className="card result-export-bar"><div><strong>当前作用范围：{selectedResults.length ? `所选 ${selectedResults.length.toLocaleString()} 条` : `当前筛选 ${filteredResults.length.toLocaleString()} 条`}</strong><small>TXT、CSV、JSON 与上方纯文本使用同一范围函数</small></div><div className="button-row"><button disabled={!scope.length} onClick={() => exportResults("txt")}>TXT</button><button disabled={!scope.length} onClick={() => exportResults("csv")}>CSV</button><button disabled={!scope.length} onClick={() => exportResults("json")}>JSON</button>{resultsDirty && <button className="primary" disabled={busy || !scope.length} onClick={() => void saveEditedResults()}>保存修改为新历史</button>}</div></section><ResultTable tool={tool} results={results} setResults={setDraftResults} selected={selected} setSelected={setSelected} notice={setNotice} onFilteredChange={setFilteredResults} /></div>}

    {stage === "script" && tool === "missav" && <div className="stack-md"><section className="callout"><strong>当前脚本范围：{selectedResults.length ? `选中结果 ${selectedResults.length.toLocaleString()} 条` : `当前筛选全部 ${filteredResults.length.toLocaleString()} 条`}</strong><p>网站只生成完整脚本，由你复制到浏览器执行；网站不会直接查询 MissAV。</p><button onClick={onOpenRuleLibrary}>编辑参考 Tag 与两层黑名单 →</button></section><MissavScriptPanel results={scope} /><section className="card"><div className="section-heading"><div><span className="eyebrow">导出</span><h3>两层黑名单与排除审计</h3></div></div><div className="button-row"><button disabled={!scope.length} onClick={() => void raindrop("csv")}>Raindrop CSV</button><button disabled={!scope.length} onClick={() => void raindrop("html")}>书签 HTML</button><button disabled={!scope.length} onClick={() => void raindrop("report")}>排除报告 JSON</button><button onClick={() => exportResults("txt")}>番号 TXT</button><button onClick={() => exportResults("csv")}>结果 CSV</button><button onClick={() => exportResults("json")}>完整 JSON</button></div></section></div>}

    {stage === "local" && tool === "av123" && <div className="stack-md"><section className="callout warning"><strong>网站不会查询或收藏 123AV</strong><p>当前范围：{selectedResults.length ? `选中结果 ${selectedResults.length.toLocaleString()} 条` : `当前筛选全部 ${filteredResults.length.toLocaleString()} 条`}。Chrome 扩展、APP 内助手与账号收藏请使用 Windows v0.5.13。</p></section><section className="card local-task-panel"><div className="section-heading"><div><span className="eyebrow">本地任务交接</span><h3>导出任务 CSV / 导入执行结果</h3></div></div><div className="button-row"><button className="primary" disabled={!scope.length} onClick={() => exportAv123Tasks(false)}>导出任务 CSV</button><button disabled={!scope.length} onClick={() => exportAv123Tasks(true)}>只重导出异常 / 待核验</button><label className="file-button"><input type="file" accept=".csv" onChange={previewAv123Import} />预览导入结果 CSV</label></div><p className="hint">稳定字段：code,url,status,task_id。没有 URL 仍保留番号；状态区分待本地处理、已导入结果、未找到、网络异常、待核验和成功。</p>{av123Preview && <section className="import-preview"><div className="metric-grid"><article className="metric"><span>匹配</span><strong>{av123Preview.matched}</strong></article><article className="metric"><span>未匹配</span><strong>{av123Preview.unmatched}</strong></article><article className="metric"><span>重复</span><strong>{av123Preview.duplicates}</strong></article><article className="metric"><span>坏行</span><strong>{av123Preview.badRows}</strong></article></div><div className="callout"><strong>将更新 {av123Preview.matched.toLocaleString()} 条</strong><p>文件：{av123Preview.fileName}。确认后才会事务写入并生成一条新历史。</p></div><div className="button-row"><button className="primary" disabled={busy || !av123Preview.matched} onClick={() => void confirmAv123Import()}>确认事务写入并保存</button><button onClick={() => setAv123Preview(null)}>取消</button></div></section>}</section></div>}

    {stage === "history" && <div className="stack-md"><section className="tool-stage-summary card"><div><span className="eyebrow">{STAGES[tool].at(-1)?.[1]}</span><h3>{active.title} 独立历史</h3></div><span>载入后返回本工具结果页</span></section><HistoryPanel refreshKey={0} toolId={tool} onLoadRun={loadHistoryRun} /></div>}
  </div>;
}

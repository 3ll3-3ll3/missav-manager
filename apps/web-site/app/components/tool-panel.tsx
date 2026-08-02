"use client";

import { useMemo, useRef, useState } from "react";
import { parseCsvRows, processDocuments } from "../../lib/rules";
import type { InputDocument } from "../../lib/rules";
import type { ToolId, ToolResult } from "../../lib/types";
import { csvSafe, safeHttpUrl } from "../../lib/security";
import MissavScriptPanel from "./missav-script-panel";
import TelegramPanel from "./telegram-panel";

const tools: Array<{ id: ToolId; mark: string; title: string; note: string }> =
  [
    {
      id: "twitter",
      mark: "#",
      title: "推特博主",
      note: "标签、@账号、个人页",
    },
    { id: "badnews", mark: "B", title: "Bad.news", note: "主题链接规范化" },
    { id: "haijiao", mark: "海", title: "海角链接", note: "限定分类与数字页" },
    {
      id: "missav",
      mark: "AV",
      title: "MissAV 番号",
      note: "降噪、去重与黑名单",
    },
    {
      id: "av123",
      mark: "123",
      title: "123AV 任务",
      note: "本地查询任务与结果回填",
    },
  ];

function download(
  name: string,
  content: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export default function ToolPanel({
  onSaved,
  onOpenTelegramSettings,
}: {
  onSaved: () => void;
  onOpenTelegramSettings: () => void;
}) {
  const [tool, setTool] = useState<ToolId>("twitter");
  const [paste, setPaste] = useState("");
  const [files, setFiles] = useState<InputDocument[]>([]);
  const [mode, setMode] = useState<"manual" | "telegram" | "script">("manual");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [results, setResults] = useState<ToolResult[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const last = useRef<number | null>(null);
  const active = tools.find((item) => item.id === tool)!;
  const documents = useMemo(
    () => [
      ...(paste.trim() ? [{ name: "粘贴文本", text: paste }] : []),
      ...files,
    ],
    [paste, files],
  );
  const chosen = selected.size
    ? results.filter((_, index) => selected.has(index))
    : results;
  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = [...(event.target.files || [])];
    const invalid = picked.find((file) => !/\.(txt|html?|md|json|csv|log)$/i.test(file.name) || file.size > 20 * 1024 * 1024);
    const totalSize = picked.reduce((sum, file) => sum + file.size, 0);
    if (invalid || totalSize > 50 * 1024 * 1024) {
      setNotice(invalid ? `文件 ${invalid.name} 类型不受支持或超过 20 MB` : "一次选择的文件总量超过 50 MB");
    } else {
      const loaded = await Promise.all(picked.map(async (file) => ({ name: file.name, text: await file.text() })));
      setFiles((current) => [...current, ...loaded]);
    }
    event.target.value = "";
  }
  function run() {
    try {
      if (!documents.length) throw new Error("请粘贴文本或添加文件");
      const output = processDocuments(tool, documents, start, end);
      setResults(output.results);
      setMessageCount(output.messages.length);
      setSelected(new Set());
      setNotice(
        `已从 ${output.messages.length} 条消息提取 ${output.results.length} 条结果`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "处理失败");
    }
  }
  function rowSelect(index: number, event: React.MouseEvent) {
    const next = new Set(selected);
    if (event.shiftKey && last.current !== null) {
      const [from, to] = [last.current, index].sort((a, b) => a - b);
      if (!event.ctrlKey && !event.metaKey) next.clear();
      for (let i = from; i <= to; i += 1) next.add(i);
    } else if (event.ctrlKey || event.metaKey) {
      if (next.has(index)) next.delete(index);
      else next.add(index);
    } else {
      next.clear();
      next.add(index);
    }
    last.current = index;
    setSelected(next);
  }
  async function save() {
    if (!results.length) return;
    setBusy(true);
    try {
      await api("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool,
          name: `${active.title} · ${new Date().toLocaleString("zh-CN")}`,
          inputKind: files.length ? "files" : "manual",
          startAt: start,
          endAt: end,
          sourceSummary: documents.map((item) => item.name).join(", "),
          results,
        }),
      });
      setNotice("结果已写入永久历史和数据中心");
      onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  function plain() {
    return chosen
      .map((item) =>
        item.secondaryValue
          ? `${item.primaryValue}\t${item.secondaryValue}`
          : item.primaryValue,
      )
      .join("\r\n");
  }
  function exportResults(format: "txt" | "csv" | "json") {
    if (format === "txt") download(`${tool}-results.txt`, plain());
    else if (format === "json")
      download(
        `${tool}-results.json`,
        JSON.stringify(
          {
            tool,
            exportedAt: new Date().toISOString(),
            count: chosen.length,
            results: chosen,
          },
          null,
          2,
        ),
        "application/json",
      );
    else
      download(
        `${tool}-results.csv`,
        `\uFEFF${[["primary", "secondary", "status", "source"].map(csvSafe).join(","), ...chosen.map((row) => [row.primaryValue, row.secondaryValue, row.status, row.source].map(csvSafe).join(","))].join("\r\n")}`,
        "text/csv;charset=utf-8",
      );
  }
  async function raindrop(kind: "csv" | "html" | "report") {
    try {
      const format = kind === "html" ? "html" : "csv";
      const payload = await api("/api/raindrop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format, results: chosen }),
      });
      if (kind === "report")
        download(
          "raindrop-exclusion-report.json",
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              included: payload.included,
              excluded: payload.excluded,
              records: payload.audits,
            },
            null,
            2,
          ),
          "application/json",
        );
      else
        download(
          `raindrop-missav.${kind}`,
          payload.content,
          kind === "html"
            ? "text/html;charset=utf-8"
            : "text/csv;charset=utf-8",
        );
      setNotice(
        `Raindrop 预览与导出共用规则：包含 ${payload.included}，排除 ${payload.excluded}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出失败");
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
      const index = (...names: string[]) =>
        headers.findIndex((value) => names.includes(value));
      const codeIndex = index("code", "番号", "primary", "primary_value");
      const statusIndex = index("status", "状态");
      const urlIndex = index("url", "av123_url", "123av_url");
      if (codeIndex < 0) throw new Error("结果 CSV 缺少 code/番号列");
      const map = new Map(
        rows.slice(1).map((row) => [
          String(row[codeIndex] || "")
            .toUpperCase()
            .replaceAll("_", "-"),
          {
            status: String(row[statusIndex] || "result_imported").slice(0, 64),
            url: safeHttpUrl(row[urlIndex] || ""),
          },
        ]),
      );
      setResults((current) =>
        current.map((item) => {
          const hit = map.get(item.primaryValue);
          return hit
            ? {
                ...item,
                status: hit.status,
                secondaryValue: hit.url || item.secondaryValue,
                metadata: { ...item.metadata, av123ResultImported: true },
              }
            : item;
        }),
      );
      setNotice(
        `已回填 ${[...map.keys()].filter((code) => results.some((item) => item.primaryValue === code)).length} 条 123AV 本地结果；请保存历史后持久化。`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "结果导入失败");
    }
  }
  return (
    <div className="stack-lg">
      <section className="tool-tabs">
        {tools.map((item) => (
          <button
            key={item.id}
            className={tool === item.id ? "active" : ""}
            onClick={() => {
              setTool(item.id);
              setMode("manual");
              setResults([]);
              setSelected(new Set());
            }}
          >
            <span>{item.mark}</span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.note}</small>
            </div>
          </button>
        ))}
      </section>
      <section className="workspace-modes">
        <button
          className={mode === "manual" ? "active" : ""}
          onClick={() => setMode("manual")}
        >
          手动 / 文件
        </button>
        <button
          className={mode === "telegram" ? "active" : ""}
          onClick={() => setMode("telegram")}
        >
          Telegram 消息
        </button>
        {tool === "missav" && (
          <button
            className={mode === "script" ? "active" : ""}
            onClick={() => setMode("script")}
          >
            浏览器脚本
          </button>
        )}
      </section>
      {mode === "telegram" && (
        <TelegramPanel
          tool={tool}
          onProcessed={onSaved}
          onOpenTelegramSettings={onOpenTelegramSettings}
        />
      )}
      {mode === "script" && tool === "missav" && (
        <MissavScriptPanel results={chosen.length ? chosen : results} />
      )}
      {mode === "manual" && (
        <section className="workspace-grid">
          <div className="card input-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">输入</span>
                <h3>{active.title}</h3>
              </div>
              <span className="subtle">支持多文件</span>
            </div>
            <label className="field">
              <span>粘贴文本</span>
              <textarea
                rows={12}
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
                placeholder="粘贴 Telegram 导出片段、普通文本或链接…"
              />
            </label>
            <label className="dropzone">
              <input
                type="file"
                multiple
                accept=".txt,.html,.htm,.md,.json,.csv,.log"
                onChange={pick}
              />
              <strong>＋ 添加导出文件</strong>
              <span>TXT · HTML · JSON · CSV · LOG</span>
            </label>
            {files.length > 0 && (
              <div className="file-list">
                {files.map((file, index) => (
                  <span key={`${file.name}-${index}`}>
                    {file.name}
                    <button
                      aria-label="移除"
                      onClick={() =>
                        setFiles((list) => list.filter((_, i) => i !== index))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="date-grid">
              <label className="field">
                <span>开始时间</span>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </label>
              <label className="field">
                <span>结束时间</span>
                <input
                  type="datetime-local"
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </label>
            </div>
            <button className="primary wide" onClick={run}>
              运行 v0.5.13 规则
            </button>
            <p className="hint">
              时间筛选只对带时间戳的 Telegram HTML/JSON
              消息生效；普通粘贴文本始终参与处理。
            </p>
          </div>
          <div className="card results-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">结果预览</span>
                <h3>{results.length.toLocaleString()} 条</h3>
              </div>
              <span className="subtle">{messageCount} 条输入消息</span>
            </div>
            {notice && <div className="notice">{notice}</div>}
            {tool === "twitter" && results.length > 0 && (
              <div className="twitter-outputs">
                <label className="field">
                  <span>用户名（一行一个）</span>
                  <textarea
                    readOnly
                    rows={4}
                    value={results.map((item) => item.primaryValue).join("\n")}
                  />
                </label>
                <label className="field">
                  <span>主页链接（一行一个）</span>
                  <textarea
                    readOnly
                    rows={4}
                    value={results
                      .map((item) => item.secondaryValue)
                      .filter(Boolean)
                      .join("\n")}
                  />
                </label>
              </div>
            )}
            <div className="result-toolbar">
              <button
                onClick={() =>
                  setSelected(
                    selected.size === results.length
                      ? new Set()
                      : new Set(results.map((_, i) => i)),
                  )
                }
              >
                {selected.size === results.length && results.length
                  ? "取消全选"
                  : "全选"}
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(plain())}
                disabled={!results.length}
              >
                复制
              </button>
              <button onClick={save} disabled={!results.length || busy}>
                {busy ? "保存中…" : "保存永久历史"}
              </button>
              {tool === "av123" && (
                <label className="file-button compact">
                  <input type="file" accept=".csv" onChange={importAv123} />
                  导入本地结果 CSV
                </label>
              )}
            </div>
            <div className="result-list">
              {!results.length ? (
                <div className="empty">
                  <span>⌁</span>
                  <strong>等待处理结果</strong>
                  <p>输入内容并运行规则后，可在这里预览、选择、复制和导出。</p>
                </div>
              ) : (
                results.map((item, index) => (
                  <button
                    key={`${item.resultKey}-${index}`}
                    className={selected.has(index) ? "selected" : ""}
                    onClick={(event) => rowSelect(index, event)}
                  >
                    <input
                      type="checkbox"
                      readOnly
                      checked={selected.has(index)}
                    />
                    <span className="row-index">{index + 1}</span>
                    <div>
                      <strong>{item.primaryValue}</strong>
                      <small>{item.secondaryValue || item.source || "—"}</small>
                    </div>
                    <span className="row-status">
                      {item.status || "success"}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="export-bar">
              <span>导出 {chosen.length.toLocaleString()} 条</span>
              <button
                onClick={() => exportResults("txt")}
                disabled={!results.length}
              >
                TXT
              </button>
              <button
                onClick={() => exportResults("csv")}
                disabled={!results.length}
              >
                {tool === "av123" ? "任务 CSV" : "CSV"}
              </button>
              <button
                onClick={() => exportResults("json")}
                disabled={!results.length}
              >
                JSON
              </button>
              {tool === "missav" && (
                <>
                  <button
                    onClick={() => raindrop("csv")}
                    disabled={!results.length}
                  >
                    Raindrop CSV
                  </button>
                  <button
                    onClick={() => raindrop("html")}
                    disabled={!results.length}
                  >
                    书签 HTML
                  </button>
                  <button
                    onClick={() => raindrop("report")}
                    disabled={!results.length}
                  >
                    排除报告
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

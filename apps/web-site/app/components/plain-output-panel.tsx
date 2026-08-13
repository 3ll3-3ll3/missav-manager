"use client";

import { useMemo, useRef, useState } from "react";
import { toolOutputFields } from "../../lib/tool-output";
import type { ToolId, ToolResult } from "../../lib/types";

export default function PlainOutputPanel({
  tool,
  filtered,
  selected,
  notice,
}: {
  tool: ToolId;
  filtered: ToolResult[];
  selected: ToolResult[];
  notice: (message: string) => void;
}) {
  const [fallback, setFallback] = useState("");
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const filteredFields = useMemo(() => toolOutputFields(tool, filtered), [tool, filtered]);
  const selectedFields = useMemo(() => toolOutputFields(tool, selected), [tool, selected]);

  async function copy(fieldIndex: number, mode: "filtered" | "selected") {
    const fields = mode === "selected" ? selectedFields : filteredFields;
    const field = fields[fieldIndex];
    const text = field?.values.join("\r\n") || "";
    if (!text) {
      notice(mode === "selected" ? "所选范围在这个字段中没有可复制内容" : "当前筛选在这个字段中没有可复制内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setFallback("");
      notice(`已复制“${field.label}” ${field.values.length.toLocaleString()} 行`);
    } catch {
      setFallback(field.key);
      const textarea = textareas.current[field.key];
      textarea?.focus();
      textarea?.select();
      notice("浏览器拒绝访问剪贴板；已为你全选文本框，请按 Ctrl+C 手动复制");
    }
  }

  return <section className="card plain-output-panel" aria-label="纯文本输出">
    <div className="section-heading"><div><span className="eyebrow">纯文本输出 · 默认展开</span><h3>一行一个，可直接全选或分别复制</h3><p className="stage-purpose">当前筛选 {filtered.length.toLocaleString()} 条{selected.length ? `；已选 ${selected.length.toLocaleString()} 条` : "；当前未选择，后续操作默认使用当前筛选"}</p></div></div>
    <div className={`plain-output-grid ${filteredFields.length > 1 ? "two" : ""}`}>
      {filteredFields.map((field, index) => <article key={field.key} className={fallback === field.key ? "clipboard-fallback" : ""}>
        <div className="plain-output-heading"><strong>{field.label}</strong><span>{field.values.length.toLocaleString()} 行</span></div>
        <textarea ref={(node) => { textareas.current[field.key] = node; }} readOnly rows={9} value={field.values.join("\n")} aria-label={field.label} />
        <div className="button-row"><button className="primary" onClick={() => void copy(index, "filtered")}>复制当前筛选</button><button disabled={!selected.length} onClick={() => void copy(index, "selected")}>复制所选{selected.length ? ` (${selected.length})` : ""}</button></div>
        {fallback === field.key && <small className="clipboard-help">文本已全选；请按 Ctrl+C。也可以在文本框内右键复制。</small>}
      </article>)}
    </div>
  </section>;
}

"use client";

import { useEffect, useState } from "react";
import { parseList } from "../../lib/rules";

type Settings = {
  referenceTags?: string[];
  referenceBlacklist?: string[];
  exportBlacklist?: string[];
};
type HtmlPreview = {
  tags: string[];
  bookmarkCount: number;
  taggedBookmarkCount: number;
  uniqueSourceTags: number;
  blacklistedTagCount: number;
};
async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
export default function LibraryPanel() {
  const [values, setValues] = useState({
    referenceTags: "",
    referenceBlacklist: "",
    exportBlacklist: "",
  });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreview | null>(null);
  useEffect(() => {
    api("/api/settings")
      .then(async (settings: Settings) => {
        let tags = settings.referenceTags || [];
        if (!tags.length) {
          const response = await fetch("/default-reference-tags.txt");
          if (response.ok) tags = parseList(await response.text());
        }
        setValues({
          referenceTags: tags.join("\n"),
          referenceBlacklist: (settings.referenceBlacklist || []).join("\n"),
          exportBlacklist: (settings.exportBlacklist || []).join("\n"),
        });
      })
      .catch((error) => setNotice(error.message))
      .finally(() => setBusy(false));
  }, []);
  async function save() {
    setBusy(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, parseList(value)]),
      );
      await api("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setNotice("规则资料库已保存到 Sites 持久化数据库");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function importHtml(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      if (!/\.html?$/i.test(file.name))
        throw new Error("请选择 Netscape 书签 HTML");
      if (file.size > 7 * 1024 * 1024) throw new Error("书签 HTML 超过 7 MB，请先拆分或仅上传脱敏书签文件");
      const preview = await api("/api/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "preview-reference-html",
          html: await file.text(),
        }),
      });
      setHtmlPreview(preview);
      setNotice(
        `识别 ${preview.bookmarkCount.toLocaleString()} 条书签、${preview.tags.length.toLocaleString()} 个女优 Tag；确认后才完整替换。`,
      );
    } catch (error) {
      setHtmlPreview(null);
      setNotice(error instanceof Error ? error.message : "HTML 解析失败");
    } finally {
      setBusy(false);
    }
  }
  function confirmHtml() {
    if (!htmlPreview) return;
    if (
      !window.confirm(
        `用识别出的 ${htmlPreview.tags.length.toLocaleString()} 个 Tag 完整替换当前参考库？第一层黑名单不会从参考库物理删除。`,
      )
    )
      return;
    setValues((current) => ({
      ...current,
      referenceTags: htmlPreview.tags.join("\n"),
    }));
    setHtmlPreview(null);
    setNotice("已载入预览结果；点击“保存资料库”后才写入数据库。");
  }
  function exportList(name: string, value: string) {
    const url = URL.createObjectURL(
      new Blob([parseList(value).join("\r\n") + "\r\n"], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="stack-lg">
      <section className="callout">
        <strong>三套列表，职责分离</strong>
        <p>
          参考女优 Tag 库只用于识别与标注；第一层只取消参考命中资格；第二层在
          Raindrop 文件中硬排除并保留审计报告。正式数据不会写入 Local Storage。
        </p>
      </section>
      <section className="card reference-import">
        <div>
          <span className="eyebrow">HTML 完整替换</span>
          <h3>从 Miss_AV.html 重新抽取参考女优 Tag</h3>
          <p>先显示书签数、识别数和被第一层名单取消的数量，再由你确认替换。</p>
        </div>
        <label className="file-button">
          <input type="file" accept=".html,.htm" onChange={importHtml} />
          {busy ? "处理中…" : "选择书签 HTML"}
        </label>
        {htmlPreview && (
          <div className="html-preview">
            <strong>{htmlPreview.tags.length.toLocaleString()} 个 Tag</strong>
            <span>
              {htmlPreview.bookmarkCount.toLocaleString()} 书签 ·{" "}
              {htmlPreview.uniqueSourceTags.toLocaleString()} 原始 Tag ·
              第一层取消 {htmlPreview.blacklistedTagCount}
            </span>
            <button className="primary" onClick={confirmHtml}>
              确认载入替换预览
            </button>
          </div>
        )}
      </section>
      <section className="library-grid">
        <Editor
          title="参考女优 Tag 库"
          badge="识别"
          value={values.referenceTags}
          onChange={(value) =>
            setValues((current) => ({ ...current, referenceTags: value }))
          }
          note="完整库保留；脚本生成时才应用第一层名单。"
        />
        <Editor
          title="参考库黑名单"
          badge="第一层"
          value={values.referenceBlacklist}
          onChange={(value) =>
            setValues((current) => ({ ...current, referenceBlacklist: value }))
          }
          note="只取消参考命中资格，不物理删除参考 Tag。"
        />
        <Editor
          title="导出黑名单"
          badge="第二层"
          value={values.exportBlacklist}
          onChange={(value) =>
            setValues((current) => ({ ...current, exportBlacklist: value }))
          }
          note="Raindrop HTML/CSV 硬排除，但报告与 JSON 保留原因。"
        />
      </section>
      {notice && <div className="notice">{notice}</div>}
      <div className="sticky-actions">
        <span>
          {Object.values(values)
            .reduce((sum, value) => sum + parseList(value).length, 0)
            .toLocaleString()}{" "}
          个列表项
        </span>
        <button
          onClick={() =>
            exportList("missav-reference-tags.txt", values.referenceTags)
          }
        >
          导出参考库
        </button>
        <button
          onClick={() =>
            exportList("1-reference-blacklist.txt", values.referenceBlacklist)
          }
        >
          导出第一层
        </button>
        <button
          onClick={() =>
            exportList("2-raindrop-blacklist.txt", values.exportBlacklist)
          }
        >
          导出第二层
        </button>
        <button className="primary" onClick={save} disabled={busy}>
          {busy ? "处理中…" : "保存资料库"}
        </button>
      </div>
    </div>
  );
}
function Editor({
  title,
  badge,
  value,
  onChange,
  note,
}: {
  title: string;
  badge: string;
  value: string;
  onChange: (value: string) => void;
  note: string;
}) {
  return (
    <article className="card library-card">
      <div className="section-heading">
        <div>
          <span className="eyebrow">{badge}</span>
          <h3>{title}</h3>
        </div>
        <strong className="count-chip">
          {parseList(value).length.toLocaleString()}
        </strong>
      </div>
      <p>{note}</p>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        placeholder="每行一个值"
      />
    </article>
  );
}

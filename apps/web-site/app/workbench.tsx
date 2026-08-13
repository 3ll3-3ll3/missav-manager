"use client";

import { useEffect, useState } from "react";
import type { ToolId } from "../lib/types";
import DataCenter from "./components/data-center";
import HistoryPanel from "./components/history-panel";
import LibraryPanel from "./components/library-panel";
import LogsPanel from "./components/logs-panel";
import MigrationPanel from "./components/migration-panel";
import SnapshotsPanel from "./components/snapshots-panel";
import TaskCenter from "./components/task-center";
import TelegramSettingsPanel from "./components/telegram-settings";
import ToolPanel, { TOOL_DEFINITIONS } from "./components/tool-panel";

type ViewId = "home" | "processing" | "data" | "telegram" | "logs" | "settings" | "tool";
type DataTab = "records" | "history" | "library" | "migration" | "snapshots";
type SettingsTab = "general" | "windows";
type Bootstrap = {
  summary: { records: number; runs: number; migrations: number };
};

const NAV: Array<{ id: Exclude<ViewId, "tool">; label: string; icon: string }> = [
  { id: "home", label: "工具首页", icon: "⌂" },
  { id: "processing", label: "处理中心", icon: "◎" },
  { id: "data", label: "数据中心", icon: "▦" },
  { id: "telegram", label: "Telegram", icon: "✈" },
  { id: "logs", label: "日志", icon: "≡" },
  { id: "settings", label: "设置", icon: "⚙" },
];

const DATA_TABS: Array<{ id: DataTab; label: string }> = [
  { id: "records", label: "永久数据" },
  { id: "history", label: "处理历史" },
  { id: "library", label: "规则库" },
  { id: "migration", label: "迁移" },
  { id: "snapshots", label: "恢复点" },
];

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function Workbench({ owner }: { owner: string }) {
  const [view, setView] = useState<ViewId>("home");
  const [activeTool, setActiveTool] = useState<ToolId>("twitter");
  const [telegramTool, setTelegramTool] = useState<ToolId | undefined>();
  const [dataTab, setDataTab] = useState<DataTab>("records");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [menu, setMenu] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [requestedRun, setRequestedRun] = useState<{ tool: ToolId; runId: string; nonce: number } | null>(null);

  useEffect(() => {
    fetch("/api/bootstrap", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      })
      .then(setBootstrap)
      .catch(() => setBootstrap(null));
  }, [refreshKey]);

  useEffect(() => {
    const applyHash = () => {
      const value = window.location.hash.replace(/^#\/?/, "");
      const [kind, id] = value.split("/");
      if (kind === "tool" && TOOL_DEFINITIONS.some((item) => item.id === id)) { setActiveTool(id as ToolId); setView("tool"); }
      else if (NAV.some((item) => item.id === value)) setView(value as Exclude<ViewId, "tool">);
    };
    applyHash(); window.addEventListener("hashchange", applyHash); return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  function go(id: ViewId) {
    if (id === "telegram") setTelegramTool(undefined);
    setView(id);
    setMenu(false);
    window.history.replaceState(null, "", id === "home" ? "#home" : `#${id}`);
  }

  function openTool(tool: ToolId) {
    setActiveTool(tool);
    setView("tool");
    setMenu(false);
    window.history.replaceState(null, "", `#tool/${tool}`);
  }

  function openToolBinding(tool: ToolId) {
    setTelegramTool(tool);
    setView("telegram");
    window.history.replaceState(null, "", "#telegram");
  }

  function openTask(tool: ToolId, runId: string) {
    if (!runId) return;
    setRequestedRun({ tool, runId, nonce: Date.now() });
    openTool(tool);
  }

  function openRuleLibrary() {
    setDataTab("library");
    setView("data");
    setMenu(false);
    window.history.replaceState(null, "", "#data");
  }

  const title = view === "tool"
    ? TOOL_DEFINITIONS.find((tool) => tool.id === activeTool)?.title || "工具"
    : NAV.find((item) => item.id === view)?.label || "TG 内容工具箱";
  const activeNav = view === "tool" ? "home" : view;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand"><span className="brand-mark">TG</span><div><strong>TG 内容工具箱</strong><small>PRIVATE WEB · v0.5.13 UX</small></div></div>
        <nav>{NAV.map((item) => <button className={activeNav === item.id ? "active" : ""} onClick={() => go(item.id)} key={item.id}><span>{item.icon}</span>{item.label}</button>)}</nav>
        <div className="sidebar-note"><span className="status-dot" />私人访问已启用<small>云端 D1 独立于 Windows SQLite</small></div>
        <div className="account"><span className="avatar">B</span><div><strong>{owner}</strong><small>网站所有者</small></div></div>
      </aside>
      {menu && <button className="backdrop" aria-label="关闭菜单" onClick={() => setMenu(false)} />}
      <main className="main-area">
        <header className="topbar"><button className="menu-button" onClick={() => setMenu(true)}>☰</button><div><span className="eyebrow">TG 内容工具箱</span><h1>{title}</h1></div><div className="top-actions"><span className="db-badge"><span className="status-dot" />Sites D1</span><button className="icon-button" title="刷新" aria-label="刷新页面数据" onClick={() => setRefreshKey((key) => key + 1)}>↻</button></div></header>
        <div className="page-content">
          {view === "home" && <ToolHome data={bootstrap} openTool={openTool} openData={() => go("data")} />}
          {TOOL_DEFINITIONS.map((definition) => <div key={definition.id} className={view === "tool" && activeTool === definition.id ? "tool-route active" : "tool-route"} hidden={view !== "tool" || activeTool !== definition.id}><ToolPanel tool={definition.id} requestedRun={requestedRun?.tool === definition.id ? requestedRun : null} onSaved={() => setRefreshKey((key) => key + 1)} onOpenTelegramSettings={openToolBinding} onOpenRuleLibrary={openRuleLibrary} onBack={() => go("home")} /></div>)}
          {view === "processing" && <TaskCenter onOpenTask={openTask} />}
          {view === "data" && <><SecondaryNav items={DATA_TABS} value={dataTab} setValue={(value) => setDataTab(value as DataTab)} />{dataTab === "records" && <DataCenter refreshKey={refreshKey} />}{dataTab === "history" && <HistoryPanel refreshKey={refreshKey} />}{dataTab === "library" && <LibraryPanel />}{dataTab === "migration" && <MigrationPanel onChanged={() => setRefreshKey((key) => key + 1)} />}{dataTab === "snapshots" && <SnapshotsPanel />}</>}
          {view === "telegram" && <TelegramSettingsPanel key={telegramTool || "global"} initialTool={telegramTool} />}
          {view === "logs" && <LogsPanel />}
          {view === "settings" && <><SecondaryNav items={[{ id: "general", label: "通用" }, { id: "windows", label: "Windows 说明" }]} value={settingsTab} setValue={(value) => setSettingsTab(value as SettingsTab)} />{settingsTab === "general" ? <GeneralSettings /> : <WindowsBoundary onExport={() => download("TG内容工具箱-Windows-v0.5.13-交接.txt", DESKTOP_HANDOFF)} />}</>}
        </div>
      </main>
    </div>
  );
}

function SecondaryNav({ items, value, setValue }: { items: Array<{ id: string; label: string }>; value: string; setValue: (value: string) => void }) {
  return <nav className="secondary-nav" aria-label="二级页面">{items.map((item) => <button key={item.id} className={value === item.id ? "active" : ""} onClick={() => setValue(item.id)}>{item.label}</button>)}</nav>;
}

function ToolHome({ data, openTool, openData }: { data: Bootstrap | null; openTool: (tool: ToolId) => void; openData: () => void }) {
  return <div className="stack-lg"><section className="hero tool-home-hero"><div><span className="pill">Windows v0.5.13 体验基线</span><h2>TG 内容工具箱</h2><p>五个工具各自保留独立输入、筛选、选择和结果。Telegram 是每个工具输入页的子模式，全局只登录和配置一次。</p><div className="button-row"><button className="primary" onClick={() => openTool("twitter")}>打开第一个工具</button><button onClick={openData}>查看永久数据</button></div></div><div className="hero-gauge"><span>独立工作区</span><strong>5</strong><small>文本工具 3 阶段 · 专用工具 4 阶段</small></div></section><section className="tool-home-grid">{TOOL_DEFINITIONS.map((tool, index) => <button key={tool.id} className={`tool-home-card tool-${tool.id}`} onClick={() => openTool(tool.id)}><span className="tool-card-index">0{index + 1}</span><span className="tool-card-mark">{tool.mark}</span><div><strong>{tool.title}</strong><p>{tool.note}</p><small>{tool.id === "missav" ? "输入 · 结果 · 浏览器脚本 · 历史" : tool.id === "av123" ? "输入 · 结果 · 本地任务 · 历史" : "输入 · 结果 · 历史"}</small></div><span className="tool-card-arrow">→</span></button>)}</section><section className="metric-grid"><Metric label="永久记录" value={data?.summary.records} note="D1 服务端分页" /><Metric label="处理历史" value={data?.summary.runs} note="五工具独立检索" /><Metric label="迁移批次" value={data?.summary.migrations} note="预览与恢复点" /><Metric label="Telegram 来源" value={100} note="按最多 100 来源设计" /></section><section className="callout"><strong>数据边界保持独立</strong><p>云端 D1 与 Windows SQLite 不做实时双向同步；两端只对齐业务字段和 TXT/CSV/JSON 导出格式。</p></section></div>;
}

function Metric({ label, value, note }: { label: string; value: number | undefined; note: string }) {
  return <article className="metric"><span>{label}</span><strong>{value === undefined ? "—" : value.toLocaleString()}</strong><small>{note}</small></article>;
}

function GeneralSettings() {
  return <div className="stack-md"><section className="card"><span className="eyebrow">外观</span><h3>v0.5.13 护眼淡绿</h3><p className="subtle">默认主题使用淡绿色页面、白绿面板和深绿操作色，不加载背景图。</p><div className="theme-swatches"><span style={{ background: "#e9f3e7" }}>页面</span><span style={{ background: "#f7fbf5" }}>面板</span><span style={{ background: "#278f58", color: "white" }}>主操作</span></div></section><section className="card"><span className="eyebrow">数据与安全</span><h3>私人网站边界</h3><ul className="boundary-list"><li><span>独立</span>云端 D1 与 Windows SQLite 不做实时双向同步</li><li><span>全局</span>Telegram 个人账号与 Bot 只配置一次</li><li><span>恢复</span>删除、覆盖和队列处理前建立恢复点</li><li><span>权限</span>生产 API 继续要求 ChatGPT 身份头</li></ul></section><section className="callout warning"><strong>待用户 E2E 验收</strong><p>Telegram 真实登录、加密 Session 恢复、Bot 拉取、远端编辑/删除传播及 safe_auto / never / manual 三种已读策略，必须由所有者在真实账号上操作确认；构建通过不代表这些外部副作用已验收。</p></section></div>;
}

const DESKTOP_HANDOFF = `TG 内容工具箱 · Windows v0.5.13 交接\n\nWindows 稳定参考：codex/v0.5.13-desktop-stable / v0.5.13-desktop-baseline / 4e2aad0\n\n云端 D1 与 Windows SQLite 继续独立，不做实时双向同步，只统一字段和导出格式。\nTelegram 网站端与 Windows 各自使用独立 Session。真实登录、Session 恢复、Bot 拉取、编辑/删除和三种已读策略仍待用户 E2E 验收。\n`;

function WindowsBoundary({ onExport }: { onExport: () => void }) {
  return <div className="stack-md"><section className="callout warning"><strong>Windows v0.5.13 是稳定回退边界</strong><p>本次没有修改 Windows 稳定分支、标签、Release 或 EXE。网站端只对齐使用体验、字段与导出格式。</p></section><section className="boundary-cards"><article className="card"><span className="online-badge">WEB + WINDOWS</span><h3>Telegram 个人账号</h3><p>两端各自使用独立 Session；网站复用全局连接和检查点，不共享 Windows 登录态。</p></article><article className="card"><span className="local-badge">WINDOWS</span><h3>本地 SQLite 与 EXE</h3><p>桌面稳定资产保持不动，生产数据库也不会被本次改造写入。</p></article><article className="card"><span className="online-badge">统一格式</span><h3>导出交接</h3><p>TXT、CSV、JSON 字段语义对齐，可人工导入导出，但不做实时同步。</p></article></section><button className="primary" onClick={onExport}>导出 Windows 交接说明</button></div>;
}

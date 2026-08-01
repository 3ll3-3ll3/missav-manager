"use client";

import { useEffect, useState } from "react";
import DataCenter from "./components/data-center";
import HistoryPanel from "./components/history-panel";
import LibraryPanel from "./components/library-panel";
import MigrationPanel from "./components/migration-panel";
import ToolPanel from "./components/tool-panel";

export type ViewId = "overview" | "tools" | "records" | "history" | "library" | "migration" | "desktop";
type Bootstrap = { summary: { records:number; runs:number; migrations:number }; history: { rows: Array<Record<string, unknown>> }; migrations: Array<Record<string,unknown>> };

const nav: Array<{ id:ViewId; label:string; icon:string }> = [
  { id:"overview", label:"总览", icon:"⌂" },
  { id:"tools", label:"内容处理", icon:"⌁" },
  { id:"records", label:"数据中心", icon:"▦" },
  { id:"history", label:"永久历史", icon:"◷" },
  { id:"library", label:"规则资料库", icon:"◇" },
  { id:"migration", label:"数据迁移", icon:"⇄" },
  { id:"desktop", label:"桌面端能力", icon:"▣" },
];

function download(name:string, content:string, type="text/plain;charset=utf-8") {
  const url=URL.createObjectURL(new Blob([content],{type})); const anchor=document.createElement("a");
  anchor.href=url; anchor.download=name; anchor.click(); URL.revokeObjectURL(url);
}

export default function Workbench({ owner }:{ owner:string }) {
  const [view,setView]=useState<ViewId>("overview");
  const [bootstrap,setBootstrap]=useState<Bootstrap | null>(null);
  const [menu,setMenu]=useState(false);
  const [refreshKey,setRefreshKey]=useState(0);
  useEffect(()=>{ fetch("/api/bootstrap").then(async response=>{ if(!response.ok) throw new Error(await response.text()); return response.json(); }).then(setBootstrap).catch(()=>setBootstrap(null)); },[refreshKey]);
  const go=(id:ViewId)=>{ setView(id); setMenu(false); };
  return <div className="app-shell">
    <aside className={`sidebar ${menu?"open":""}`}>
      <div className="brand"><span className="brand-mark">M</span><div><strong>MissAV Manager</strong><small>PRIVATE WEB · v0.5.13</small></div></div>
      <nav>{nav.map(item=><button className={view===item.id?"active":""} onClick={()=>go(item.id)} key={item.id}><span>{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-note"><span className="status-dot"/>私人访问已启用<small>仅当前账号可访问</small></div>
      <div className="account"><span className="avatar">B</span><div><strong>{owner}</strong><small>网站所有者</small></div></div>
    </aside>
    {menu&&<button className="backdrop" aria-label="关闭菜单" onClick={()=>setMenu(false)}/>} 
    <main className="main-area">
      <header className="topbar"><button className="menu-button" onClick={()=>setMenu(true)}>☰</button><div><span className="eyebrow">私人数据工作区</span><h1>{nav.find(item=>item.id===view)?.label}</h1></div><div className="top-actions"><span className="db-badge"><span className="status-dot"/>Sites 数据库</span><button className="icon-button" title="刷新" onClick={()=>setRefreshKey(key=>key+1)}>↻</button></div></header>
      <div className="page-content">
        {view==="overview"&&<Overview data={bootstrap} open={go}/>} 
        {view==="tools"&&<ToolPanel onSaved={()=>setRefreshKey(key=>key+1)}/>} 
        {view==="records"&&<DataCenter refreshKey={refreshKey}/>} 
        {view==="history"&&<HistoryPanel refreshKey={refreshKey}/>} 
        {view==="library"&&<LibraryPanel/>} 
        {view==="migration"&&<MigrationPanel onChanged={()=>setRefreshKey(key=>key+1)}/>} 
        {view==="desktop"&&<DesktopBoundary onExport={()=>download("Windows-v0.5.13-功能交接.txt",desktopHandoff)}/>} 
      </div>
    </main>
  </div>;
}

function Overview({data,open}:{data:Bootstrap|null;open:(view:ViewId)=>void}) {
  const summary=data?.summary;
  return <div className="stack-lg">
    <section className="hero"><div><span className="pill">B 账号专属</span><h2>桌面规则，云端整理。</h2><p>复刻 v0.5.13 的文本过滤与数据管理行为；正式数据保存在 Sites 持久化数据库，不写入浏览器本地存储。</p><div className="button-row"><button className="primary" onClick={()=>open("tools")}>开始处理内容</button><button onClick={()=>open("records")}>打开数据中心</button></div></div><div className="hero-gauge"><span>稳定基线</span><strong>4e2aad0</strong><small>Windows v0.5.13 独立保留</small></div></section>
    <section className="metric-grid"><Metric label="永久记录" value={summary?.records} note="服务端分页，按 10 万+ 设计"/><Metric label="处理历史" value={summary?.runs} note="保存结果，不保存原始 Telegram 内容"/><Metric label="已应用迁移" value={summary?.migrations} note="支持批次核对与回滚"/><Metric label="在线规则" value={4} note="推特 / Bad.news / 海角 / 番号"/></section>
    <section className="two-column"><div className="card"><div className="section-heading"><div><span className="eyebrow">快速入口</span><h3>四类内容处理</h3></div></div><div className="quick-grid">{[["#","推特博主","ASCII 标签、@账号与个人页"],["B","Bad.news","规范化主题链接"],["海","海角链接","限定分类与数字页面"],["AV","MissAV 番号","降噪、去重与双层黑名单"]].map(([icon,title,note])=><button key={title} onClick={()=>open("tools")}><span>{icon}</span><strong>{title}</strong><small>{note}</small></button>)}</div></div><div className="card"><span className="eyebrow">边界清晰</span><h3>仍在 Windows 桌面端</h3><ul className="boundary-list"><li><span>本地</span>Telegram 个人账号 API、扫码/手机号登录、远端标已读</li><li><span>本地</span>123AV 查询、Chrome 扩展与账号收藏</li><li><span>网站</span>生成 Raindrop 导入文件，但不直连 API</li></ul><button onClick={()=>open("desktop")}>查看交接与导出入口 →</button></div></section>
  </div>;
}
function Metric({label,value,note}:{label:string;value:number|undefined;note:string}) { return <article className="metric"><span>{label}</span><strong>{value===undefined?"—":value.toLocaleString()}</strong><small>{note}</small></article>; }

const desktopHandoff=`MissAV Manager Windows v0.5.13 本地功能交接\n\n稳定参考：codex/v0.5.13-desktop-stable / v0.5.13-desktop-baseline / 4e2aad0\n\n继续由 Windows 桌面端完成：\n1. Telegram 个人账号 API、扫码/手机号登录、远端标已读。\n2. 123AV 查询、Chrome 扩展和账号收藏。\n\n私人网站不持有这些本地凭据，也不会伪装为在线实现。网站可导出 TXT/CSV/JSON 与 Raindrop 导入文件，再交给本地流程继续处理。\n`;
function DesktopBoundary({onExport}:{onExport:()=>void}) { return <div className="stack-lg"><section className="callout warning"><strong>这些功能没有迁移到网站</strong><p>它们依赖个人账号会话、本机浏览器或远端已读操作，继续由 Windows v0.5.13 承担。网站不会要求或记录这些密钥。</p></section><section className="boundary-cards"><article className="card"><span className="local-badge">WINDOWS ONLY</span><h3>Telegram 个人账号</h3><p>API ID/Hash、扫码或手机号登录、会话文件与远端标已读均留在桌面端。</p></article><article className="card"><span className="local-badge">WINDOWS ONLY</span><h3>123AV 与浏览器</h3><p>123AV 查询、Chrome 扩展、账号收藏均留在桌面端；网站只保留数据字段和可导出入口。</p></article><article className="card"><span className="online-badge">WEB</span><h3>Raindrop 文件</h3><p>网站在内容处理页生成 CSV/HTML 导入文件，第一版不直接连接 Raindrop API。</p></article></section><div className="card"><h3>本地交接</h3><p>下载一份边界说明，随导出的 TXT/CSV/JSON 一起交给 Windows 工具。</p><button className="primary" onClick={onExport}>导出桌面端交接说明</button></div></div>; }

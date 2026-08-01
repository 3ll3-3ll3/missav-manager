"use client";

import { useMemo, useState } from "react";
import { normalizeScriptCodes } from "../../lib/missav";
import type { ToolResult } from "../../lib/types";

type Generated={script:string;codes:string[];referenceTagCount:number;referenceBlacklistCount:number;exportBlacklistCount:number;templateHash:string;generationId:string};
async function api(url:string,options?:RequestInit){const response=await fetch(url,options);const payload=await response.json().catch(()=>({error:"请求失败"}));if(!response.ok)throw new Error(payload.error||"请求失败");return payload;}
function download(name:string,content:string){const url=URL.createObjectURL(new Blob([content],{type:"text/javascript;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}

export default function MissavScriptPanel({results}:{results:ToolResult[]}){
  const suggested=useMemo(()=>normalizeScriptCodes(results.map(item=>item.primaryValue)),[results]);
  const [manual,setManual]=useState("");const [generated,setGenerated]=useState<Generated|null>(null);const [busy,setBusy]=useState(false);const [notice,setNotice]=useState("");
  const codes=normalizeScriptCodes(manual.trim()?manual.split(/\r?\n|[,，\s]+/):suggested);
  async function generate(){setBusy(true);setNotice("");try{const payload=await api("/api/scripts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({codes})});setGenerated(payload);setNotice(`已生成 ${payload.codes.length} 个番号的完整脚本；数据库只记录哈希和数量。`);}catch(error){setNotice(error instanceof Error?error.message:"生成失败");}finally{setBusy(false);}}
  return <section className="card script-panel"><div className="section-heading"><div><span className="eyebrow">MissAV 浏览器脚本</span><h3>v0.5.13 完整三目录脚本</h3></div><span className="count-chip">{codes.length.toLocaleString()} 番号</span></div><div className="callout"><strong>脚本行为保持桌面基线</strong><p>只注入当次番号、参考 Tag、第一层黑名单过滤后的参考库和第二层导出黑名单；脚本固定生成“参考女优Tag命中 / 需要查找 / 其他”。</p></div><label className="field"><span>番号范围（留空时使用当前结果）</span><textarea rows={8} value={manual} onChange={event=>setManual(event.target.value)} placeholder={suggested.join("\n")||"先在手动输入或 Telegram 消息中提取番号"}/></label><div className="button-row"><button className="primary" disabled={!codes.length||busy} onClick={generate}>{busy?"生成中…":"生成完整脚本"}</button>{generated&&<><button onClick={()=>navigator.clipboard.writeText(generated.script)}>复制脚本</button><button onClick={()=>download("missav-browser-script-v0.5.13.js",generated.script)}>下载 .js</button></>}</div>{notice&&<div className="notice">{notice}</div>}{generated&&<dl className="script-metrics"><div><dt>番号</dt><dd>{generated.codes.length}</dd></div><div><dt>有效参考 Tag</dt><dd>{generated.referenceTagCount}</dd></div><div><dt>第一层名单</dt><dd>{generated.referenceBlacklistCount}</dd></div><div><dt>第二层名单</dt><dd>{generated.exportBlacklistCount}</dd></div><div><dt>模板 SHA-256</dt><dd title={generated.templateHash}>{generated.templateHash.slice(0,16)}…</dd></div></dl>}</section>;
}


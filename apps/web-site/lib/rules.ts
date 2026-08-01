import type { ToolId, ToolResult } from "./types";

export type InputDocument = { name: string; text: string };
export type InputMessage = {
  text: string; links: string[]; messageDate: string; sourceType: string; source: string;
};

const TWITTER_RESERVED = new Set(["about","compose","explore","hashtag","home","i","intent","login","messages","notifications","search","settings","share","signup"]);
const HAIJIAO_CATEGORIES = ["hjjd","hjmz","hjyc","hjfn","hjsz","hjrq","hjhj"];
const NOISE_PREFIXES = new Set([
  "MESSAGE","MESSAGES","USERPIC","MEDIA","VIDEO","PHOTO","AVATAR","PAGINATION","DETAILS","STATUS","TITLE","BODY","CLASS","STYLE",
  "DATE","HTML","BUTTON","INPUT","IMAGE","THUMB","THUMBNAIL","AV","TOP","BEST","FUCK","MOODYZ","TAMEIKE","ALL","PDF","TELEGRAM",
  "LOGO","JOHREN","IEOR","PROBABILITY","STATISTICS","PYTHON","OFFICE","GITHUB","SERIES","WEIXIN","RESULT","RELATED","THREAD","XIUREN",
  "WXSYNC","JAVA","LARGE","RJ","NO","PRO","YOUPORN","TV",
]);
const DATE_PREFIXES = new Set(["JAN","JANUARY","FEB","FEBRUARY","MAR","MARCH","APR","APRIL","MAY","JUN","JUNE","JUL","JULY","AUG","AUGUST","SEP","SEPT","SEPTEMBER","OCT","OCTOBER","NOV","NOVEMBER","DEC","DECEMBER"]);
const TRUSTED_AV_HOSTS = ["missav.ai","missav.ws","123av.com","avbase.net","javdb.com","javbus.com","javlibrary.com","supjav.com","njav.tv","jable.tv","jav.guru"];

function decodeLooseText(text: string) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&#x([0-9a-f]+);/gi,(_, hex) => String.fromCharCode(parseInt(hex,16)))
    .replace(/&#(\d+);/g,(_, dec) => String.fromCharCode(parseInt(dec,10)));
}

export function normalizeCode(value: string) {
  let text = String(value || "").trim();
  if (/^https?:\/\//i.test(text) || /missav\./i.test(text) || /-(chinese-subtitle|uncensored-leak)$/i.test(text)) {
    const fromUrl = extractCodeFromUrl(text); if (fromUrl) return fromUrl;
  }
  text = decodeLooseText(text).toUpperCase().replace(/\s+/g, "");
  const fc2 = text.match(/^FC2[_-]?(?:PPV[_-]?)?(\d{4,10})$/i);
  if (fc2) return `FC2-PPV-${fc2[1]}`;
  const normal = text.match(/^([A-Z]{2,8})[-_]?(\d{2,5})$/);
  return normal ? `${normal[1]}-${normal[2]}` : text;
}

function extractCodeFromUrl(input: string) {
  let slug = String(input || "").trim();
  try { slug = new URL(slug).pathname.split("/").filter(Boolean).at(-1) || ""; }
  catch { slug = slug.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) || slug; }
  try { slug = decodeURIComponent(slug); } catch { /* keep undecoded slug */ }
  slug = slug.replace(/-chinese-subtitle$/i,"").replace(/-uncensored-leak(?:ed)?$/i,"").replace(/[_\s]+/g,"-").trim();
  const fc2 = slug.match(/^fc2(?:-?ppv)?-?(\d{4,10})$/i);
  if (fc2) return `FC2-PPV-${fc2[1]}`;
  const normal = slug.match(/^(?:\d{1,4})?([a-z]{2,8})-?(\d{2,5})$/i);
  return normal ? `${normal[1].toUpperCase()}-${normal[2]}` : "";
}

function codeKey(code: string) { return normalizeCode(code).replace(/-/g, ""); }
function isNoiseCode(code: string) {
  const match = code.match(/^([A-Z]+)-(\d+)$/); if (!match) return false;
  const prefix = match[1]; const number = Number(match[2]);
  if (NOISE_PREFIXES.has(prefix)) return true;
  if (DATE_PREFIXES.has(prefix) && number >= 1900 && number <= 2099) return true;
  return ["SPRING","SUMMER","FALL","AUTUMN","WINTER"].includes(prefix) && number >= 1900 && number <= 2099;
}
function isCode(code: string, trusted = false) {
  if (!/^(FC2-PPV-\d{4,10}|[A-Z]{2,8}-\d{2,5})$/.test(code)) return false;
  return trusted || (!/^PPV-/.test(code) && !isNoiseCode(code));
}
function trustedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./,"");
  return TRUSTED_AV_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
function codesFromTrustedUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.replace(/[.,;!?，。；！？]+$/, "")); } catch { return [] as string[]; }
  if (!trustedHost(url.hostname)) return [];
  const output: string[] = [];
  const exact = extractCodeFromUrl(url.href); if (isCode(exact, true)) output.push(exact);
  const source = decodeURIComponent(url.pathname);
  for (const match of source.matchAll(/(?:^|[^a-z0-9])fc2(?:[\s_-]*ppv)?[\s_-]*(\d{4,10})(?=$|[^0-9])/gi)) output.push(`FC2-PPV-${match[1]}`);
  for (const match of source.matchAll(/(?:^|[^a-z])([a-z]{2,8})[\s_-]+(\d{2,5})(?=$|[^0-9])/gi)) {
    const code = normalizeCode(`${match[1]}-${match[2]}`); if (isCode(code)) output.push(code);
  }
  return [...new Set(output)];
}

function maskNoise(text: string) {
  const blank = (match: string) => match.replace(/[^\r\n]/g," ");
  return text
    .replace(/https?:\/\/[^\s"'<>)]*/gi,blank).replace(/<[^>]*>/g,blank)
    .replace(/\b\d{1,5}\s*[×x]\s*\d{1,5}\b/gi,blank).replace(/\b\d+(?:[.,]\d+)?\s*(?:bytes?|[kmgt]i?b)\b/gi,blank)
    .replace(/\bview\s+results\s+page\b/gi,blank).replace(/\b(?:powered\s+by\s+)?whos\.tv\b/gi,blank)
    .replace(/\bmissav\s+daily\b/gi,blank).replace(/\buncensored[\s_-]+leak(?:ed)?\b/gi,blank)
    .replace(/@\s*[a-z][a-z0-9_]{1,31}/gi,blank)
    .replace(/\b[a-z][a-z0-9_]{1,31}\s+\d{1,2}\s*(?:岁|years?\s+old)/gi,blank)
    .replace(/\b[a-z][a-z0-9_]{1,31}\s+\d{1,3}\s*(?:秒|分钟|小时|小時|天)前/gi,blank);
}

export function parseCodeList(input: string) {
  const decoded = decodeLooseText(String(input || ""));
  const found: Array<{ code: string; index: number }> = [];
  const add = (raw: string, index: number, trusted = false) => {
    const code = normalizeCode(raw); if (isCode(code, trusted)) found.push({ code, index });
  };
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) for (const code of codesFromTrustedUrl(match[0])) add(code, match.index || 0, true);
  const visible = maskNoise(decoded);
  for (const match of visible.matchAll(/(^|[^A-Za-z0-9])FC2(?:[ \t_-]*PPV)?[ \t_-]*(\d{4,10})(?=$|[^A-Za-z0-9])/gi)) add(`FC2-PPV-${match[2]}`, (match.index || 0) + match[1].length);
  for (const match of visible.matchAll(/(^|[^A-Za-z0-9])([A-Za-z]{2,8})[ \t_-]+(\d{2,5})(?=$|[^A-Za-z0-9])/g)) add(`${match[2]}-${match[3]}`, (match.index || 0) + match[1].length);
  for (const match of visible.matchAll(/(^|[^A-Za-z0-9])([A-Z]{2,8})(\d{2,5})(?=$|[^A-Za-z0-9])/g)) add(`${match[2]}-${match[3]}`, (match.index || 0) + match[1].length);
  const seen = new Set<string>();
  return found.sort((a,b) => a.index - b.index).filter(({code}) => { const key = codeKey(code); if (seen.has(key)) return false; seen.add(key); return true; }).map(({code}) => code);
}

export function parseTelegramDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) { const date = new Date(value > 1e12 ? value : value * 1000); return Number.isNaN(date.getTime()) ? null : date; }
  const text = String(value || "").trim(); if (!text) return null;
  const telegram = text.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{2}):?(\d{2})$/i);
  if (telegram) {
    const [,day,month,year,hour,minute,second="0",sign,offsetHour,offsetMinute] = telegram;
    const offset = (Number(offsetHour)*60 + Number(offsetMinute)) * (sign === "+" ? 1 : -1);
    return new Date(Date.UTC(Number(year),Number(month)-1,Number(day),Number(hour),Number(minute),Number(second)) - offset*60_000);
  }
  const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function filterByTime(messages: InputMessage[], start = "", end = "") {
  const startDate = start ? new Date(start) : null; const endDate = end ? new Date(end) : null;
  if (endDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end)) endDate.setSeconds(59,999);
  return messages.filter((message) => {
    const date = parseTelegramDate(message.messageDate);
    if (!date) return !((startDate || endDate) && /^(?:export_|api|bot_|telegram)/i.test(message.sourceType));
    return !(startDate && date < startDate) && !(endDate && date > endDate);
  });
}

function collectJsonMessages(value: unknown, source: string, output: InputMessage[]) {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.messages)) {
    for (const message of object.messages as Array<Record<string, unknown>>) {
      if (!message || typeof message !== "object") continue;
      const flatten = (item: unknown): string => Array.isArray(item) ? item.map(flatten).join("") : typeof item === "object" && item ? flatten((item as Record<string,unknown>).text ?? (item as Record<string,unknown>).caption ?? "") : String(item ?? "");
      const text = flatten(message.text ?? message.caption ?? "");
      const links = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((match) => match[0]);
      output.push({ text, links, messageDate: String(message.date ?? message.date_unixtime ?? ""), sourceType: "export_json", source });
    }
  }
  for (const child of Object.values(object)) if (child && typeof child === "object" && child !== object.messages) collectJsonMessages(child, source, output);
}

function parseHtmlMessages(text: string, source: string): InputMessage[] {
  if (typeof DOMParser === "undefined") return [{ text: decodeLooseText(text.replace(/<[^>]+>/g," ")), links: [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((m)=>m[0]), messageDate:"", sourceType:"manual", source }];
  const document = new DOMParser().parseFromString(text,"text/html");
  const nodes = [...document.querySelectorAll<HTMLElement>(".message[id], .message.default")];
  return nodes.filter((node)=>!node.classList.contains("service")).map((node)=>{
    const body = node.querySelector<HTMLElement>(".text");
    const links = [...node.querySelectorAll<HTMLAnchorElement>("a[href]")].map((anchor)=>anchor.href || anchor.getAttribute("href") || "").filter((href)=>/^https?:\/\//i.test(href));
    const date = node.querySelector<HTMLElement>(".date.details, .pull_right.date.details");
    return { text: body?.innerText || body?.textContent || node.textContent || "", links, messageDate: date?.getAttribute("title") || date?.dataset.time || "", sourceType:"export_html", source };
  });
}

export function parseDocument(document: InputDocument): InputMessage[] {
  const text = document.text.replace(/^\uFEFF/,""); const trimmed = text.trim(); if (!trimmed) return [];
  if (/^\s*[\[{]/.test(trimmed)) { try { const output: InputMessage[] = []; collectJsonMessages(JSON.parse(trimmed),document.name,output); if (output.length) return output; } catch { /* plain text */ } }
  if (/<html[\s>]|class=["'][^"']*message/i.test(trimmed)) { const messages = parseHtmlMessages(text,document.name); if (messages.length) return messages; }
  return [{ text, links:[...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((m)=>m[0]), messageDate:"", sourceType:"manual", source:document.name }];
}

function messageText(message: InputMessage) { return [message.text,...message.links].filter(Boolean).join("\n"); }
function validHandle(value: string) { const handle = value.trim().replace(/^[@#]/,""); return /^[A-Za-z0-9_]{1,15}$/.test(handle) && !TWITTER_RESERVED.has(handle.toLowerCase()) ? handle : ""; }
function sourceFor(value: string, messages: InputMessage[]) { const needle = value.toLowerCase(); return messages.find((message)=>messageText(message).toLowerCase().includes(needle))?.source || ""; }

function twitterResults(messages: InputMessage[]) {
  const seen = new Set<string>(); const output: Array<{name:string;url:string}> = [];
  const add = (raw: string) => { const handle = validHandle(raw); const key = handle.toLowerCase(); if (!handle || seen.has(key)) return; seen.add(key); output.push({name:handle,url:`https://x.com/${handle}`}); };
  for (const message of messages) {
    const text = messageText(message);
    const candidates: Array<{ index: number; value: string }> = [];
    for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_])#([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu)) {
      const handle = validHandle(match[1]); const index = Number(match.index || 0) + match[0].lastIndexOf("#"); const prefix = text.slice(Math.max(0,index-24),index);
      if (handle.length >= 4 && !/传送门[\s：:→-]*$/u.test(prefix)) candidates.push({ index, value: handle });
    }
    for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu)) if (!/_bot$/i.test(match[1])) candidates.push({ index: Number(match.index || 0) + match[0].lastIndexOf("@"), value: match[1] });
    for (const match of text.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=$|[/?#\s"'<>])/gi)) candidates.push({ index: Number(match.index || 0), value: match[1] });
    candidates.sort((left,right)=>left.index-right.index).forEach((candidate)=>add(candidate.value));
  }
  return output;
}

function linkResults(messages: InputMessage[], kind: "badnews"|"haijiao") {
  const seen = new Set<string>(); const output: string[] = [];
  const category = HAIJIAO_CATEGORIES.join("|");
  const pattern = kind === "badnews" ? /https?:\/\/(?:www\.)?bad\.news\/t\/\d+(?:[/?#][^\s"'<>]*)?/gi : new RegExp(`https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(?:${category})\\/\\d+\\.html(?:[/?#][^\\s"'<>]*)?`,`gi`);
  for (const message of messages) for (const match of messageText(message).matchAll(pattern)) {
    const canonical = kind === "badnews"
      ? match[0].match(/bad\.news\/t\/(\d+)/i)?.[1]
      : match[0].match(new RegExp(`haijiaolove\\.xyz\\/(${category})\\/(\\d+)\\.html`,`i`));
    const url = kind === "badnews" ? (canonical ? `https://bad.news/t/${canonical}` : "") : (canonical ? `https://www.haijiaolove.xyz/${canonical[1].toLowerCase()}/${canonical[2]}.html` : "");
    if (url && !seen.has(url)) { seen.add(url); output.push(url); }
  }
  return output;
}

function trustedSiteUrl(value: string, tool: ToolId) {
  try {
    const url = new URL(value.replace(/[.,;!?，。；！？]+$/, ""));
    const host = url.hostname.toLowerCase().replace(/^www\./,"");
    const domains = tool === "av123" ? ["123av.com"] : ["missav.ai","missav.ws"];
    if (!domains.some((domain)=>host===domain || host.endsWith(`.${domain}`))) return "";
    url.hash="";
    return url.href;
  } catch { return ""; }
}

export function processDocuments(tool: ToolId, documents: InputDocument[], start = "", end = "") {
  const allMessages = documents.flatMap(parseDocument); const messages = filterByTime(allMessages,start,end);
  let results: ToolResult[] = [];
  if (tool === "twitter") results = twitterResults(messages).map((item)=>({resultKey:item.name.toLowerCase(),primaryValue:item.name,secondaryValue:item.url,source:sourceFor(item.name,messages),metadata:{profileUrl:item.url}}));
  else if (tool === "badnews" || tool === "haijiao") results = linkResults(messages,tool).map((url)=>({resultKey:url,primaryValue:url,source:sourceFor(url,messages),metadata:{url}}));
  else {
    const combined = messages.map(messageText).join("\n"); const codes = parseCodeList(combined); const sources = [...combined.matchAll(/https?:\/\/[^\s"'<>)]*/gi)].map((m)=>trustedSiteUrl(m[0], tool)).filter(Boolean);
    results = codes.map((code)=>{
      const sourceUrl = sources.find((url)=>codesFromTrustedUrl(url).some((candidate)=>codeKey(candidate)===codeKey(code))) || "";
      return { resultKey:code.toLowerCase(),primaryValue:code,secondaryValue:sourceUrl,status:tool === "av123" ? "task_ready" : "pending",source:sourceUrl || documents.map((item)=>item.name).join(", "),metadata:{querySite:tool === "av123" ? "123AV local task" : "MissAV"} };
    });
  }
  return { messages, results };
}

export function parseList(text: string) { return [...new Set(String(text||"").replace(/^\uFEFF/,"").split(/\r?\n|[,，]/).map((value)=>value.trim().slice(0,120)).filter(Boolean))]; }

export function parseCsvRows(text: string) {
  const rows: string[][] = []; let row: string[] = []; let value = ""; let quoted = false;
  for (let index=0; index<text.length; index+=1) { const char=text[index]; if (quoted) { if (char==='"' && text[index+1]==='"') { value+='"'; index+=1; } else if (char==='"') quoted=false; else value+=char; } else if (char==='"') quoted=true; else if (char===',') { row.push(value); value=""; } else if (char==='\n') { row.push(value.replace(/\r$/,"") ); if (row.some(Boolean)) rows.push(row); row=[]; value=""; } else value+=char; }
  row.push(value.replace(/\r$/,"") ); if (row.some(Boolean)) rows.push(row); return rows;
}

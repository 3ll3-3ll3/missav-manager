import { redact } from "./security";

class HttpError extends Error {
  constructor(message:string,public status:number){super(message);}
}

export function apiError(error: unknown) {
  const message = redact(error instanceof Error ? error.message : String(error || "请求失败"));
  return Response.json({ error: message }, { status: error instanceof HttpError ? error.status : 400 });
}

export function requireAuthenticated(request: Request) {
  const hostname = new URL(request.url).hostname;
  if (["terminal.local", "localhost", "127.0.0.1"].includes(hostname)) return;
  if (!request.headers.get("oai-authenticated-user-email")) throw new HttpError("需要使用获准的 ChatGPT 账号访问此私人网站。",401);
}

export async function bodyJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new HttpError("请求格式必须是 JSON",415);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 8 * 1024 * 1024) throw new HttpError("单次请求超过 8 MB，请分批处理",413);
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>8*1024*1024)throw new HttpError("单次请求超过 8 MB，请分批处理",413);
  try{return JSON.parse(raw) as Record<string,unknown>;}catch{throw new HttpError("JSON 内容无法解析",400);}
}

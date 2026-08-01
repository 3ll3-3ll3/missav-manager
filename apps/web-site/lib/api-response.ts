export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "请求失败");
  return Response.json({ error: message }, { status: 400 });
}

export async function bodyJson(request: Request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 8 * 1024 * 1024) throw new Error("单次请求超过 8 MB，请分批处理");
  return await request.json() as Record<string, unknown>;
}

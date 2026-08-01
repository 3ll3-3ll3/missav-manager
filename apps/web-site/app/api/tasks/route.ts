import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { ensureSchema } from "../../../lib/server-store";
import { listTasks, updateTasks } from "../../../lib/server-audit";

export async function GET(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const params=new URL(request.url).searchParams; return Response.json(await listTasks({ page:Number(params.get("page")||1),pageSize:Number(params.get("pageSize")||50),stage:params.get("stage")||"",tool:params.get("tool")||"",search:params.get("search")||"" })); }
  catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const input=await bodyJson(request); return Response.json(await updateTasks((input.ids as string[])||[],String(input.stage||""))); }
  catch (error) { return apiError(error); }
}


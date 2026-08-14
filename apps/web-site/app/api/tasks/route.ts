import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { ensureSchema } from "../../../lib/server-store";
import { exportTasks, listTasks, resolveTaskSelection, updateTasks } from "../../../lib/server-audit";

export async function GET(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const params=new URL(request.url).searchParams; return Response.json(await listTasks({ page:Number(params.get("page")||1),pageSize:Number(params.get("pageSize")||50),phase:params.get("phase")||"",stage:params.get("stage")||"",tool:params.get("tool")||"",search:params.get("search")||"",sort:params.get("sort")||"updatedAt",direction:params.get("direction")==="asc"?"asc":"desc" })); }
  catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const input=await bodyJson(request); const ids=await resolveTaskSelection(input as Parameters<typeof resolveTaskSelection>[0]); return Response.json(await updateTasks(ids,String(input.stage||""))); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const input=await bodyJson(request); if(input.action!=="export")throw new Error("未知任务操作"); const ids=await resolveTaskSelection(input as Parameters<typeof resolveTaskSelection>[0]); const format=input.format==="csv"?"csv":"txt"; return Response.json({content:await exportTasks(ids,format),count:ids.length}); }
  catch (error) { return apiError(error); }
}

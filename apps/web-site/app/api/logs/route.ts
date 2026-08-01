import { apiError, requireAuthenticated } from "../../../lib/api-response";
import { ensureSchema } from "../../../lib/server-store";
import { listLogs } from "../../../lib/server-audit";

export async function GET(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const params=new URL(request.url).searchParams; return Response.json(await listLogs({ page:Number(params.get("page")||1),pageSize:Number(params.get("pageSize")||50),level:params.get("level")||"",search:params.get("search")||"" })); }
  catch (error) { return apiError(error); }
}


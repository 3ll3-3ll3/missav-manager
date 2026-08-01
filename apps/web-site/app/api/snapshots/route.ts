import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { ensureSchema } from "../../../lib/server-store";
import { listSnapshots, restoreSnapshot } from "../../../lib/server-audit";

export async function GET(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); return Response.json({ snapshots: await listSnapshots(50) }); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { requireAuthenticated(request); await ensureSchema(); const input=await bodyJson(request); if(input.action!=="restore")throw new Error("未知恢复点操作"); return Response.json(await restoreSnapshot(String(input.snapshotId||""))); }
  catch (error) { return apiError(error); }
}

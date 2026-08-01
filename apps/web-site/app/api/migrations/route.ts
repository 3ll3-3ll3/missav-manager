import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { listImportBatches, migrationAction } from "../../../lib/server-store";

export async function GET(request: Request) {
  try { requireAuthenticated(request); return Response.json({ batches: await listImportBatches(30) }); } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try { requireAuthenticated(request); return Response.json(await migrationAction(await bodyJson(request))); } catch (error) { return apiError(error); }
}

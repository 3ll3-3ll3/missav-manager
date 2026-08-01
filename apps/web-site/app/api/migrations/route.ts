import { apiError, bodyJson } from "../../../lib/api-response";
import { listImportBatches, migrationAction } from "../../../lib/server-store";

export async function GET() {
  try { return Response.json({ batches: await listImportBatches(30) }); } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try { return Response.json(await migrationAction(await bodyJson(request))); } catch (error) { return apiError(error); }
}

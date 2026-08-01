import { dashboardSummary, getSettings, listImportBatches, listRuns } from "../../../lib/server-store";
import { apiError } from "../../../lib/api-response";

export async function GET() {
  try {
    const [summary, settings, history, migrations] = await Promise.all([
      dashboardSummary(), getSettings(), listRuns(1, 8), listImportBatches(8),
    ]);
    return Response.json({ summary, settings, history, migrations });
  } catch (error) { return apiError(error); }
}

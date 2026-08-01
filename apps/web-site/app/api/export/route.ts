import { apiError, requireAuthenticated } from "../../../lib/api-response";
import { exportRecords, exportRunResults } from "../../../lib/server-store";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const params = new URL(request.url).searchParams;
    const runId=params.get("runId");
    if(runId){const content=await exportRunResults(runId);return new Response(content,{headers:{"content-type":"application/json; charset=utf-8","content-disposition":`attachment; filename="history-${runId}.json"`}});}
    const rawFormat = params.get("format");
    const format = rawFormat === "json" || rawFormat === "txt" || rawFormat === "tsv" ? rawFormat : "csv";
    const content = await exportRecords({
      tool: params.get("tool") || "", status: params.get("status") || "", search: params.get("search") || "",
    }, format);
    return new Response(content, {
      headers: {
        "content-type": format === "json" ? "application/json; charset=utf-8" : format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="missav-manager-records.${format}"`,
      },
    });
  } catch (error) { return apiError(error); }
}

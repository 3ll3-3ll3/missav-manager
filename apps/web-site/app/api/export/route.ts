import { apiError } from "../../../lib/api-response";
import { exportRecords } from "../../../lib/server-store";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const format = params.get("format") === "json" ? "json" : "csv";
    const content = await exportRecords({
      tool: params.get("tool") || "", status: params.get("status") || "", search: params.get("search") || "",
    }, format);
    return new Response(content, {
      headers: {
        "content-type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="missav-manager-records.${format}"`,
      },
    });
  } catch (error) { return apiError(error); }
}

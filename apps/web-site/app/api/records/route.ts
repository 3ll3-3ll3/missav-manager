import { apiError, bodyJson } from "../../../lib/api-response";
import { bulkRecords, createRecord, listRecords, updateRecord } from "../../../lib/server-store";
import type { RecordFilters, SanitizedImportRecord } from "../../../lib/types";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return Response.json(await listRecords({
      page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 50),
      tool: params.get("tool") || "", status: params.get("status") || "", search: params.get("search") || "",
      sort: params.get("sort") || "updatedAt", direction: params.get("direction") === "asc" ? "asc" : "desc",
    }));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try { return Response.json(await createRecord(await bodyJson(request) as SanitizedImportRecord), { status: 201 }); }
  catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const input = await bodyJson(request);
    if (input.action === "bulk-update") return Response.json(await bulkRecords({
      action: "update", mode: input.mode === "all" ? "all" : "ids", ids: input.ids as string[],
      excludeIds: input.excludeIds as string[], filters: input.filters as RecordFilters, field: String(input.field), value: input.value,
    }));
    await updateRecord(String(input.id || ""), String(input.field || ""), input.value);
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    const input = await bodyJson(request);
    return Response.json(await bulkRecords({
      action: "delete", mode: input.mode === "all" ? "all" : "ids", ids: input.ids as string[],
      excludeIds: input.excludeIds as string[], filters: input.filters as RecordFilters,
    }));
  } catch (error) { return apiError(error); }
}

import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { deleteSelectedRuns, exportSelectedRuns, getRun, listRuns, mutateRun, resolveRunSelection, saveRun } from "../../../lib/server-store";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) return Response.json(await getRun(id,Number(url.searchParams.get("resultPage")||1),Number(url.searchParams.get("resultPageSize")||100)));
    return Response.json(await listRuns(
      Number(url.searchParams.get("page") || 1), Number(url.searchParams.get("pageSize") || 30),
      url.searchParams.get("tool") || "", url.searchParams.get("search") || "", url.searchParams.get("sort") || "createdAt", url.searchParams.get("direction") === "asc" ? "asc" : "desc",
    ));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    if (input.action === "selection-export") {
      const ids = await resolveRunSelection(input as Parameters<typeof resolveRunSelection>[0]);
      const format = input.format === "csv" ? "csv" : input.format === "txt" ? "txt" : "json";
      return Response.json({ content: await exportSelectedRuns(ids, format), count: ids.length });
    }
    return Response.json(await saveRun(input as Parameters<typeof saveRun>[0]), { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    await mutateRun(String(input.id || ""), "rename", String(input.name || ""));
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    requireAuthenticated(request);
    if (request.headers.get("content-type")?.includes("application/json")) {
      const input = await bodyJson(request);
      const ids = await resolveRunSelection(input as Parameters<typeof resolveRunSelection>[0]);
      return Response.json({ ok: true, ...(await deleteSelectedRuns(ids)) });
    }
    const id = new URL(request.url).searchParams.get("id") || "";
    const result=await mutateRun(id, "delete");
    return Response.json({ ok: true,...result });
  } catch (error) { return apiError(error); }
}

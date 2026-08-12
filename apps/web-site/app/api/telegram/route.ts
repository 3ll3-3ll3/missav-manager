import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { applyTelegramMigration, bindTelegramSource, checkTelegramBotConnection, deleteTelegramBotConnection, exportTelegramQueue, importTelegramMessages, listTelegramQueue, processTelegramQueue, pullTelegramBot, resolveTelegramQueueSelection, saveTelegramBindings, telegramMigrationPreview, telegramStatus, updateTelegramQueue, updateTelegramSource } from "../../../lib/server-telegram";
import { discoverPersonalSources, logoutMtproto, markTelegramSourceRead, syncPersonalSources } from "../../../lib/server-mtproto";
import type { TelegramImportMessage } from "../../../lib/telegram";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "queue") return Response.json(await listTelegramQueue({
      tool: params.get("tool") || "", page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 50),
      status: params.get("status") || "", search: params.get("search") || "", start: params.get("start") || "", end: params.get("end") || "",
      sourceIds: (params.get("sourceIds") || "").split(",").map(String).filter(Boolean),
    }), { headers: { "cache-control": "private, no-store" } });
    if (params.get("view") === "tool") {
      const status = await telegramStatus();
      const tool = String(params.get("tool") || "");
      const bound = status.bindings.filter((row: Record<string, unknown>) => String(row.tool) === tool).map((row: Record<string, unknown>) => String(row.source_id));
      return Response.json({ ...status, boundSourceIds: bound }, { headers: { "cache-control": "private, no-store" } });
    }
    return Response.json(await telegramStatus(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    if (input.action === "check-bot") return Response.json(await checkTelegramBotConnection());
    if (input.action === "pull") return Response.json(await pullTelegramBot());
    if (input.action === "import") return Response.json(await importTelegramMessages((Array.isArray(input.messages) ? input.messages : []) as TelegramImportMessage[]));
    if (input.action === "bind") return Response.json(await bindTelegramSource({ sourceId: String(input.sourceId || ""), tool: String(input.tool || ""), enabled: input.enabled !== false }));
    if (input.action === "save-bindings") return Response.json(await saveTelegramBindings((Array.isArray(input.changes) ? input.changes : []) as Parameters<typeof saveTelegramBindings>[0]));
    if (input.action === "source-update") return Response.json(await updateTelegramSource({ sourceId: String(input.sourceId || ""), archived: input.archived === undefined ? undefined : Boolean(input.archived), accessStatus: input.accessStatus ? String(input.accessStatus) : undefined, readPolicy: input.readPolicy ? String(input.readPolicy) : undefined }));
    if (input.action === "delete-bot-connection") return Response.json(await deleteTelegramBotConnection());
    if (input.action === "delete-personal-connection") return Response.json(await logoutMtproto());
    if (input.action === "discover") return Response.json(await discoverPersonalSources());
    if (input.action === "sync-personal") return Response.json(await syncPersonalSources({ sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [], mode: ["incremental", "recent", "range", "history"].includes(String(input.mode)) ? input.mode as "incremental" | "recent" | "range" | "history" : "incremental", limit: Number(input.limit || 200), start: String(input.start || ""), end: String(input.end || "") }));
    if (input.action === "mark-read") return Response.json(await markTelegramSourceRead(input.sourceId, input.maxId));
    if (input.action === "migration-preview") return Response.json(await telegramMigrationPreview());
    if (input.action === "migration-apply") return Response.json(await applyTelegramMigration({ migrationId: String(input.migrationId || ""), confirm: input.confirm === true }));
    if (input.action === "process") {const queueIds=await resolveTelegramQueueSelection(input as Parameters<typeof resolveTelegramQueueSelection>[0]);return Response.json(await processTelegramQueue({ tool: String(input.tool || ""), queueIds, deleteBody: input.deleteBody !== false }));}
    if (input.action === "queue-status") {const queueIds=await resolveTelegramQueueSelection(input as Parameters<typeof resolveTelegramQueueSelection>[0]);return Response.json(await updateTelegramQueue(queueIds, input.status === "ignored" ? "ignored" : "pending"));}
    if(input.action==="export"){const queueIds=await resolveTelegramQueueSelection(input as Parameters<typeof resolveTelegramQueueSelection>[0]);const format=input.format==="csv"?"csv":"txt";return Response.json({content:await exportTelegramQueue(queueIds,format),count:queueIds.length});}
    throw new Error("未知 Telegram 操作");
  } catch (error) { return apiError(error); }
}

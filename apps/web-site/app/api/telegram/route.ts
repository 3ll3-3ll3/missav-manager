import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { bindTelegramSource, exportTelegramQueue, importTelegramMessages, listTelegramQueue, processTelegramQueue, pullTelegramBot, resolveTelegramQueueSelection, telegramStatus, updateTelegramQueue } from "../../../lib/server-telegram";
import type { TelegramImportMessage } from "../../../lib/telegram";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "queue") return Response.json(await listTelegramQueue({
      tool: params.get("tool") || "", page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 50),
      status: params.get("status") || "", search: params.get("search") || "", start: params.get("start") || "", end: params.get("end") || "",
    }));
    return Response.json(await telegramStatus());
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    if (input.action === "pull") return Response.json(await pullTelegramBot());
    if (input.action === "import") return Response.json(await importTelegramMessages((Array.isArray(input.messages) ? input.messages : []) as TelegramImportMessage[]));
    if (input.action === "bind") return Response.json(await bindTelegramSource({ sourceId: String(input.sourceId || ""), tool: String(input.tool || ""), enabled: input.enabled !== false }));
    if (input.action === "process") {const queueIds=await resolveTelegramQueueSelection(input as Parameters<typeof resolveTelegramQueueSelection>[0]);return Response.json(await processTelegramQueue({ tool: String(input.tool || ""), queueIds, deleteBody: input.deleteBody !== false }));}
    if (input.action === "queue-status") {const queueIds=await resolveTelegramQueueSelection(input as Parameters<typeof resolveTelegramQueueSelection>[0]);return Response.json(await updateTelegramQueue(queueIds, input.status === "ignored" ? "ignored" : "pending"));}
    if(input.action==="export"){const queueIds=await resolveTelegramQueueSelection(input as Parameters<typeof resolveTelegramQueueSelection>[0]);const format=input.format==="csv"?"csv":"txt";return Response.json({content:await exportTelegramQueue(queueIds,format),count:queueIds.length});}
    throw new Error("未知 Telegram 操作");
  } catch (error) { return apiError(error); }
}

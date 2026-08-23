import {
  apiError,
  bodyJson,
  requireAuthenticated,
} from "../../../lib/api-response";
import {
  applyTelegramMigration,
  bindTelegramSource,
  checkTelegramBotConnection,
  createTelegramSnapshot,
  createTelegramLocalQueueMessage,
  deleteTelegramBotConnection,
  deleteTelegramQueueRows,
  exportTelegramQueue,
  importTelegramMessages,
  listTelegramQueue,
  processTelegramQueue,
  pullTelegramBot,
  resolveBoundToolSyncSources,
  resolveTelegramQueueSelection,
  saveTelegramBindings,
  telegramMigrationPreview,
  telegramBindingsStatus,
  telegramConnectionStatus,
  telegramSourcesStatus,
  telegramStatus,
  telegramSyncStatus,
  telegramToolStatus,
  updateTelegramQueue,
  updateTelegramSource,
} from "../../../lib/server-telegram";
import {
  discoverPersonalSources,
  logoutMtproto,
  markTelegramSourceRead,
  mtprotoSessionLeaseStatus,
  mtprotoStatus,
  syncPersonalSources,
} from "../../../lib/server-mtproto";
import { redact } from "../../../lib/security";
import {
  normalizeTelegramToolSyncRequest,
  type TelegramImportMessage,
} from "../../../lib/telegram";
import { withCloudTelegramSourceLeases } from "../../../lib/cloud-sync";

function processTelegramStream(
  tool: string,
  queueIds: string[],
  deleteBody: boolean,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      void processTelegramQueue({
        tool,
        queueIds,
        deleteBody,
        onProgress: (progress) => send({ type: "progress", progress }),
      })
        .then((result) => {
          send({ type: "complete", result });
          controller.close();
        })
        .catch((error) => {
          send({
            type: "error",
            error: redact(
              error instanceof Error
                ? error.message
                : String(error || "Telegram 消息处理失败"),
            ),
          });
          controller.close();
        });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

type ToolSyncInput = {
  tool?: unknown;
  sourceIds?: unknown;
  mode?: unknown;
  limit?: unknown;
  start?: unknown;
  end?: unknown;
};

async function runToolSourceSync(
  input: ToolSyncInput,
  onProgress?: (progress: Record<string, unknown>) => void,
  shouldStop: () => boolean = () => false,
) {
  const normalized = normalizeTelegramToolSyncRequest({
    tool: String(input.tool || ""),
    sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds : [],
    mode: input.mode,
    limit: input.limit,
    start: input.start,
    end: input.end,
  });
  const requestedSourceIds = normalized.sourceIds;
  onProgress?.({
    phase: "scope",
    label: "正在核对当前工具绑定来源",
    current: 0,
    total: requestedSourceIds.length,
    resultCount: 0,
  });
  const scope = await resolveBoundToolSyncSources({
    tool: String(input.tool || ""),
    sourceIds: requestedSourceIds,
  });
  const mode = normalized.mode;
  let inserted = 0;
  let personalProgressInserted = 0;
  const personal = scope.personalSourceIds.length
    ? await withCloudTelegramSourceLeases(scope.personalSourceIds, "telegram-personal", (assertLease) =>
        syncPersonalSources(
          {
            sourceIds: scope.personalSourceIds,
            mode,
            limit: normalized.limit,
            start: normalized.start,
            end: normalized.end,
          },
          (progress) => {
            assertLease();
            if (progress.phase === "source_completed")
              personalProgressInserted += Number(progress.inserted || 0);
            onProgress?.({
              ...progress,
              total: requestedSourceIds.length,
              resultCount: personalProgressInserted,
            });
          },
          () => {
            if (shouldStop()) return true;
            try { assertLease(); return false; } catch { return true; }
          },
          assertLease,
        ),
      )
    : null;
  inserted = Number(personal?.inserted || 0);
  // Bot owns one account-wide getUpdates cursor; pages commit independently.
  const bot =
    scope.botSourceIds.length && mode === "incremental"
      ? await withCloudTelegramSourceLeases([], "telegram-bot", (assertLease) =>
          pullTelegramBot(
            (progress) => {
              assertLease();
              onProgress?.({
                ...progress,
                current: scope.personalSourceIds.length,
                total: requestedSourceIds.length,
                resultCount: inserted + progress.inserted,
              });
            },
            { limit: normalized.limit, shouldStop: () => {
              if (shouldStop()) return true;
              try { assertLease(); return false; } catch { return true; }
            }, assertRemoteLease: assertLease },
          ),
        )
      : scope.botSourceIds.length
        ? {
            skipped: true,
            reason:
              "Bot API 不提供历史分页；历史模式只读取所选个人 API 来源，Bot 仍保留全局 getUpdates 单游标",
            inserted: 0,
            stopped: false,
          }
        : null;
  inserted += Number(bot?.inserted || 0);
  const stopped = Boolean(personal?.stopped || bot?.stopped || shouldStop());
  onProgress?.({
    phase: "completed",
    label: stopped
      ? "已在安全批次边界停止，已提交的 offset 与检查点已保留"
      : "同步完成，offset 与检查点已安全提交",
    current: requestedSourceIds.length,
    total: requestedSourceIds.length,
    resultCount: inserted,
  });
  return {
    scope,
    request: normalized,
    personal,
    bot,
    stopped,
    reusedGlobalCursor: true,
  };
}

function syncToolSourcesStream(input: ToolSyncInput) {
  const encoder = new TextEncoder();
  let stopRequested = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          stopRequested = true;
        }
      };
      void runToolSourceSync(
        input,
        (progress) => send({ type: "progress", progress }),
        () => stopRequested,
      )
        .then((result) => {
          send({ type: "complete", result });
          try {
            controller.close();
          } catch {
            // The browser may have requested a safe stop after a committed batch.
          }
        })
        .catch((error) => {
          send({
            type: "error",
            error: redact(
              error instanceof Error
                ? error.message
                : String(error || "Telegram 同步失败"),
            ),
          });
          try {
            controller.close();
          } catch {
            // A cancelled stream already closed its controller.
          }
        });
    },
    cancel() {
      stopRequested = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function telegramSyncOperationStream(
  run: (
    onProgress: (progress: Record<string, unknown>) => void,
  ) => Promise<unknown>,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      void run((progress) => send({ type: "progress", progress }))
        .then((result) => {
          send({ type: "complete", result });
          controller.close();
        })
        .catch((error) => {
          send({
            type: "error",
            error: redact(
              error instanceof Error
                ? error.message
                : String(error || "Telegram 同步失败"),
            ),
          });
          controller.close();
        });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "queue")
      return Response.json(
        await listTelegramQueue({
          tool: params.get("tool") || "",
          page: Number(params.get("page") || 1),
          pageSize: Number(params.get("pageSize") || 200),
          status: params.get("status") || "",
          search: params.get("search") || "",
          start: params.get("start") || "",
          end: params.get("end") || "",
          sort: params.get("sort") || "messageDate",
          direction: params.get("direction") === "asc" ? "asc" : "desc",
          sourceIds: (params.get("sourceIds") || "")
            .split(",")
            .map(String)
            .filter(Boolean),
          includeCleaned: params.get("includeCleaned") === "1",
          includeNoise: params.get("includeNoise") === "1",
          errorOnly: params.get("errorOnly") === "1",
        }),
        { headers: { "cache-control": "private, no-store" } },
      );
    if (params.get("view") === "tool") {
      const tool = String(params.get("tool") || "");
      return Response.json(await telegramToolStatus(tool), {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (params.get("view") === "personal-session-lease") {
      return Response.json(await mtprotoSessionLeaseStatus(), {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (params.get("view") === "connections") {
      return Response.json(
        {
          ...(await telegramConnectionStatus()),
          mtproto: await mtprotoStatus(),
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    if (params.get("view") === "sources") {
      return Response.json(
        await telegramSourcesStatus({
          page: Number(params.get("page") || 1),
          pageSize: Number(params.get("pageSize") || 100),
          search: params.get("search") || "",
          chatType: params.get("chatType") || "",
          accessStatus: params.get("accessStatus") || "",
          includeArchived: params.get("includeArchived") === "1",
        }),
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    if (params.get("view") === "bindings") {
      return Response.json(await telegramBindingsStatus(), {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (params.get("view") === "syncs") {
      return Response.json(await telegramSyncStatus(), {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (params.get("view") === "settings") {
      const status = await telegramStatus();
      return Response.json(
        { ...status, mtproto: await mtprotoStatus() },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    return Response.json(await telegramStatus(), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    if (input.action === "check-bot")
      return Response.json(await checkTelegramBotConnection());
    if (input.action === "pull-stream")
      return telegramSyncOperationStream((onProgress) =>
        withCloudTelegramSourceLeases([], "telegram-bot", (assertLease) =>
          pullTelegramBot((progress) => { assertLease(); onProgress(progress); }, { assertRemoteLease: assertLease }),
        ),
      );
    if (input.action === "pull") return Response.json(await withCloudTelegramSourceLeases([], "telegram-bot", (assertLease) =>
      pullTelegramBot(undefined, { shouldStop: () => { try { assertLease(); return false; } catch { return true; } }, assertRemoteLease: assertLease }),
    ));
    if (input.action === "import")
      return Response.json(
        await importTelegramMessages(
          (Array.isArray(input.messages)
            ? input.messages
            : []) as TelegramImportMessage[],
        ),
      );
    if (input.action === "bind")
      return Response.json(
        await bindTelegramSource({
          sourceId: String(input.sourceId || ""),
          tool: String(input.tool || ""),
          enabled: input.enabled !== false,
        }),
      );
    if (input.action === "save-bindings")
      return Response.json(
        await saveTelegramBindings(
          (Array.isArray(input.changes) ? input.changes : []) as Parameters<
            typeof saveTelegramBindings
          >[0],
        ),
      );
    if (input.action === "source-update")
      return Response.json(
        await updateTelegramSource({
          sourceId: String(input.sourceId || ""),
          archived:
            input.archived === undefined ? undefined : Boolean(input.archived),
          accessStatus: input.accessStatus
            ? String(input.accessStatus)
            : undefined,
          readPolicy: input.readPolicy ? String(input.readPolicy) : undefined,
        }),
      );
    if (input.action === "delete-bot-connection")
      return Response.json(await deleteTelegramBotConnection());
    if (input.action === "delete-personal-connection") {
      const snapshotId = await createTelegramSnapshot(
        "删除 Telegram 个人连接前自动恢复点",
      );
      return Response.json({ ...(await logoutMtproto()), snapshotId });
    }
    if (input.action === "discover")
      return Response.json(await discoverPersonalSources());
    if (input.action === "sync-personal-stream")
      return telegramSyncOperationStream((onProgress) =>
        withCloudTelegramSourceLeases(
          Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [],
          "telegram-personal",
          (assertLease) => syncPersonalSources(
            {
              sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [],
              mode: ["incremental", "recent", "range", "history"].includes(String(input.mode))
                ? (input.mode as "incremental" | "recent" | "range" | "history") : "incremental",
              limit: Number(input.limit || 200), start: String(input.start || ""), end: String(input.end || ""),
            },
            (progress) => { assertLease(); onProgress(progress); },
            () => { try { assertLease(); return false; } catch { return true; } },
            assertLease,
          ),
        ),
      );
    if (input.action === "sync-personal")
      return Response.json(
        await withCloudTelegramSourceLeases(
          Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [],
          "telegram-personal",
          (assertLease) => syncPersonalSources(
            {
              sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [],
              mode: ["incremental", "recent", "range", "history"].includes(String(input.mode))
                ? (input.mode as "incremental" | "recent" | "range" | "history") : "incremental",
              limit: Number(input.limit || 200), start: String(input.start || ""), end: String(input.end || ""),
            },
            undefined,
            () => { try { assertLease(); return false; } catch { return true; } },
            assertLease,
          ),
        ),
      );
    if (input.action === "sync-tool-sources-stream")
      return syncToolSourcesStream(input);
    if (input.action === "sync-tool-sources")
      return Response.json(await runToolSourceSync(input));
    if (input.action === "mark-read")
      return Response.json(
        await withCloudTelegramSourceLeases([String(input.sourceId || "")], "telegram-personal", (assertLease) => {
          assertLease();
          return markTelegramSourceRead(input.sourceId, input.maxId);
        }),
      );
    if (input.action === "migration-preview")
      return Response.json(await telegramMigrationPreview());
    if (input.action === "migration-apply")
      return Response.json(
        await applyTelegramMigration({
          migrationId: String(input.migrationId || ""),
          confirm: input.confirm === true,
        }),
      );
    if (input.action === "process-stream") {
      const queueIds = await resolveTelegramQueueSelection(
        input as Parameters<typeof resolveTelegramQueueSelection>[0],
      );
      return processTelegramStream(
        String(input.tool || ""),
        queueIds,
        input.deleteBody !== false,
      );
    }
    if (input.action === "process") {
      const queueIds = await resolveTelegramQueueSelection(
        input as Parameters<typeof resolveTelegramQueueSelection>[0],
      );
      return Response.json(
        await processTelegramQueue({
          tool: String(input.tool || ""),
          queueIds,
          deleteBody: input.deleteBody !== false,
        }),
      );
    }
    if (input.action === "queue-status") {
      const queueIds = await resolveTelegramQueueSelection(
        input as Parameters<typeof resolveTelegramQueueSelection>[0],
      );
      return Response.json(
        await updateTelegramQueue(
          queueIds,
          input.status === "ignored" ? "ignored" : "pending",
        ),
      );
    }
    if (input.action === "queue-create-local")
      return Response.json(
        await createTelegramLocalQueueMessage({
          tool: String(input.tool || ""),
          sourceId: String(input.sourceId || ""),
          text: String(input.text || ""),
          messageDate: String(input.messageDate || ""),
        }),
      );
    if (input.action === "queue-delete") {
      const queueIds = await resolveTelegramQueueSelection(
        input as Parameters<typeof resolveTelegramQueueSelection>[0],
      );
      return Response.json(
        await deleteTelegramQueueRows(String(input.tool || ""), queueIds),
      );
    }
    if (input.action === "export") {
      const queueIds = await resolveTelegramQueueSelection(
        input as Parameters<typeof resolveTelegramQueueSelection>[0],
      );
      const format = input.format === "csv" ? "csv" : "txt";
      return Response.json({
        content: await exportTelegramQueue(queueIds, format),
        count: queueIds.length,
      });
    }
    throw new Error("未知 Telegram 操作");
  } catch (error) {
    return apiError(error);
  }
}

import { getD1 } from "../../../db";
import { apiError, requireAuthenticated } from "../../../lib/api-response";
import {
  backupFileName,
  createDatabaseBackupStream,
  listDatabaseTables,
  validateDatabaseBackupStream,
} from "../../../lib/database-backup";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const action = new URL(request.url).searchParams.get("action");
    if (action === "inventory") return Response.json(await listDatabaseTables());
    if (action !== "download") throw new Error("必须显式选择只读清单或完整备份下载");
    return new Response(createDatabaseBackupStream(), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${backupFileName()}"`,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Backup-Consistency": "verified-on-completion",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    if (new URL(request.url).searchParams.get("action") !== "validate") throw new Error("生产 Site 仅开放备份文件校验");
    const contentType = request.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("application/x-ndjson") && !contentType.includes("application/octet-stream")) {
      throw new Error("备份文件必须是 NDJSON");
    }
    return Response.json(await validateDatabaseBackupStream(request.body, getD1()));
  } catch (error) {
    return apiError(error);
  }
}

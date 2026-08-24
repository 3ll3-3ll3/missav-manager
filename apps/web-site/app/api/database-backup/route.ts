import { getD1 } from "../../../db";
import { apiError, requireAuthenticated } from "../../../lib/api-response";
import {
  backupFileName,
  createDatabaseBackup,
  restoreDatabaseBackup,
  validateDatabaseBackup,
} from "../../../lib/database-backup";

const MAX_BACKUP_REQUEST_BYTES = 96 * 1024 * 1024;

async function backupBodyJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new Error("请求格式必须是 JSON");
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BACKUP_REQUEST_BYTES) throw new Error("备份文件超过 96 MB 上限");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_REQUEST_BYTES) throw new Error("备份文件超过 96 MB 上限");
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("JSON 内容无法解析"); }
}

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const backup = await createDatabaseBackup();
    const action = new URL(request.url).searchParams.get("action");
    if (action === "manifest") {
      return Response.json({
        createdAt: backup.createdAt,
        source: backup.source,
        security: backup.security,
        manifest: backup.manifest,
      });
    }
    return new Response(JSON.stringify(backup), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${backupFileName(backup.createdAt)}"`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await backupBodyJson(request);
    if (input.action === "validate") return Response.json(await validateDatabaseBackup(input.backup, getD1()));
    if (input.action === "restore") return Response.json(await restoreDatabaseBackup(input.backup, input.confirmation));
    throw new Error("未知数据库备份操作");
  } catch (error) {
    return apiError(error);
  }
}

import { getD1 } from "../../../db";
import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import {
  finalizeDatabaseBackup,
  listDatabaseTables,
  readDatabaseBackupPage,
  validateDatabaseBackupStream,
  type BackupPageRequest,
} from "../../../lib/database-backup";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const action = new URL(request.url).searchParams.get("action");
    if (action === "inventory") return Response.json(await listDatabaseTables());
    throw new Error("完整备份必须由所有者浏览器通过多请求只读协议生成；单请求下载已禁用");
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const action = new URL(request.url).searchParams.get("action");
    if (action === "page") {
      const body = await bodyJson(request);
      return Response.json(await readDatabaseBackupPage({
        table: String(body.table) as BackupPageRequest["table"],
        cursor: (body.cursor ?? null) as BackupPageRequest["cursor"],
        bookmark: String(body.bookmark ?? ""),
      }));
    }
    if (action === "finalize") {
      const body = await bodyJson(request);
      return Response.json(await finalizeDatabaseBackup(String(body.bookmark ?? "")));
    }
    if (action !== "validate") throw new Error("生产 Site 仅开放只读分页备份与备份文件校验");
    const contentType = request.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("application/x-ndjson") && !contentType.includes("application/octet-stream")) {
      throw new Error("备份文件必须是 NDJSON");
    }
    return Response.json(await validateDatabaseBackupStream(request.body, getD1()));
  } catch (error) {
    return apiError(error);
  }
}

import {
  apiError,
  bodyJson,
  requireAuthenticated,
} from "../../../lib/api-response";
import {
  cloudSyncStatus,
  createCloudSyncPreview,
  executeCloudSync,
  resolveCloudSyncConflict,
  retryCloudSyncConflicts,
} from "../../../lib/cloud-sync";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    const url = new URL(request.url);
    return Response.json(await cloudSyncStatus({
      testGateway: url.searchParams.get("test") === "1",
    }));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request) as Record<string, unknown>;
    if (input.action === "preview") return Response.json(await createCloudSyncPreview());
    if (input.action === "execute") {
      const mode = String(input.mode || "");
      if (!(["push", "pull", "both"] as string[]).includes(mode)) throw new Error("同步模式无效");
      return Response.json(await executeCloudSync(mode as "push" | "pull" | "both"));
    }
    if (input.action === "retry-conflicts") return Response.json(await retryCloudSyncConflicts());
    if (input.action === "resolve-conflict") {
      const choice = input.choice === "remote" ? "remote" : input.choice === "local" ? "local" : "";
      if (!choice) throw new Error("冲突处理方式无效");
      return Response.json(await resolveCloudSyncConflict(String(input.id || ""), choice));
    }
    throw new Error("未知同步操作");
  } catch (error) {
    return apiError(error);
  }
}

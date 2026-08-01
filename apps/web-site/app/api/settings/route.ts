import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { getSettings, setSettings } from "../../../lib/server-store";

export async function GET(request: Request) {
  try { requireAuthenticated(request); return Response.json(await getSettings()); } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try { requireAuthenticated(request); return Response.json(await setSettings(await bodyJson(request))); } catch (error) { return apiError(error); }
}

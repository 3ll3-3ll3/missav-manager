import { apiError, bodyJson } from "../../../lib/api-response";
import { getSettings, setSettings } from "../../../lib/server-store";

export async function GET() {
  try { return Response.json(await getSettings()); } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try { return Response.json(await setSettings(await bodyJson(request))); } catch (error) { return apiError(error); }
}

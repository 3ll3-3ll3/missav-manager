import { apiError, requireAuthenticated } from "../../../../../lib/api-response";
import { probeMtprotoRuntime } from "../../../../../lib/server-mtproto-probe";

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    return Response.json(await probeMtprotoRuntime());
  } catch (error) {
    return apiError(error);
  }
}

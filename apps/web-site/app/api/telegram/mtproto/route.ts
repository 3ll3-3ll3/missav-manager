import { apiError, bodyJson, requireAuthenticated } from "../../../../lib/api-response";
import {
  cancelMtprotoLogin,
  logoutMtproto,
  mtprotoStatus,
  pollQrLogin,
  restoreMtprotoSession,
  startPhoneLogin,
  startQrLogin,
  submitPhoneCode,
  submitTwoFactorPassword,
} from "../../../../lib/server-mtproto";

export async function GET(request: Request) {
  try {
    requireAuthenticated(request);
    return Response.json(await mtprotoStatus(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    if (input.action === "start-phone") return Response.json(await startPhoneLogin(input.phone));
    if (input.action === "submit-code") return Response.json(await submitPhoneCode(input.phone, input.code));
    if (input.action === "submit-password") return Response.json(await submitTwoFactorPassword(input.password));
    if (input.action === "start-qr") return Response.json(await startQrLogin());
    if (input.action === "poll-qr") return Response.json(await pollQrLogin());
    if (input.action === "restore") return Response.json(await restoreMtprotoSession());
    if (input.action === "cancel") return Response.json(await cancelMtprotoLogin());
    if (input.action === "logout") return Response.json(await logoutMtproto());
    throw new Error("未知 MTProto 登录操作");
  } catch (error) {
    return apiError(error);
  }
}

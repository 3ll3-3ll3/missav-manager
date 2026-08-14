import { connect } from "cloudflare:sockets";

import { writeLog } from "./server-audit";

const TELEGRAM_DC = { host: "149.154.167.51", port: 443 } as const;
const TELEGRAM_WEBSOCKET = "wss://venus.web.telegram.org/apiws";

export type MtprotoRuntimeProbe = {
  tcpReachable: boolean;
  websocketReachable: boolean;
  tcpElapsedMs: number;
  websocketElapsedMs: number;
  elapsedMs: number;
  conclusion: string;
  scope: "network_only";
};

async function probeTcp() {
  const started = Date.now();
  const socket = connect({ hostname: TELEGRAM_DC.host, port: TELEGRAM_DC.port }, { allowHalfOpen: false, secureTransport: "off" });
  const tcpReachable = await Promise.race([
    socket.opened.then(() => true, () => false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
  try { socket.close(); } catch { /* Probe cleanup is best effort. */ }
  return { reachable: tcpReachable, elapsedMs: Date.now() - started };
}

async function probeWebSocket() {
  const started = Date.now();
  const websocketReachable = await new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = new WebSocket(TELEGRAM_WEBSOCKET, "binary");
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // A failed handshake may already have closed the socket.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 8_000);
    socket.addEventListener("open", () => finish(true), { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
  });
  return { reachable: websocketReachable, elapsedMs: Date.now() - started };
}

export async function probeMtprotoRuntime(): Promise<MtprotoRuntimeProbe> {
  const started = Date.now();
  const [tcp, websocket] = await Promise.all([probeTcp(), probeWebSocket()]);
  const tcpReachable = tcp.reachable;
  const websocketReachable = websocket.reachable;
  const elapsedMs = Date.now() - started;
  const conclusion = tcpReachable && websocketReachable
    ? "当前生产运行时可以建立 Telegram TCP 与 WebSocket 连接；仍需继续验证 MTProto 握手、跨请求登录状态和 Session 恢复。"
    : `当前生产运行时网络探针未全部通过（TCP：${tcpReachable ? "可达" : "失败"}；WebSocket：${websocketReachable ? "可达" : "失败"}）。这不是删除个人 API 的依据，需复测并评估仅所有者私有 MTProto 后端。`;
  await writeLog("info", "telegram_mtproto_probe", "MTProto 网络探针完成", {
    tcpReachable,
    websocketReachable,
    tcpElapsedMs: tcp.elapsedMs,
    websocketElapsedMs: websocket.elapsedMs,
    elapsedMs,
    scope: "network_only",
  });
  return {
    tcpReachable,
    websocketReachable,
    tcpElapsedMs: tcp.elapsedMs,
    websocketElapsedMs: websocket.elapsedMs,
    elapsedMs,
    conclusion,
    scope: "network_only",
  };
}

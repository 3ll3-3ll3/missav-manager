interface D1Meta {
  changes?: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: D1Meta;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_API_ID?: string;
    TELEGRAM_API_HASH?: string;
    TELEGRAM_SESSION_ENCRYPTION_KEY?: string;
    MTPROTO_BACKEND_URL?: string;
    MTPROTO_BACKEND_TOKEN?: string;
    [key: string]: unknown;
  };
}

declare module "cloudflare:sockets" {
  export type Socket = {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<{ remoteAddress?: string; localAddress?: string }>;
    closed: Promise<void>;
    close(): void;
  };
  export function connect(
    address: { hostname: string; port: number },
    options?: { allowHalfOpen?: boolean; secureTransport?: "off" | "on" | "starttls" },
  ): Socket;
}

import { connect as connectTcp, type Socket } from "cloudflare:sockets";

type TelegramProxy = Record<string, unknown> | undefined;

const closedError = new Error("Cloudflare TCP socket was closed");

/**
 * teleproto's built-in Node socket wrapper depends on node:net event semantics.
 * Sites runs on workerd, so use Cloudflare's native TCP streams instead and
 * adapt them to the small read/write interface teleproto expects.
 */
export class CloudflareTelegramSocket {
  static readonly isWebSocket = false;

  private socket?: Socket;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private closed = true;
  private chunks: Buffer[] = [];
  private headOffset = 0;
  private available = 0;
  private canRead: Promise<boolean> = Promise.resolve(false);
  private resolveRead?: (value: boolean) => void;
  private terminalError: Error | null = null;

  constructor(proxy?: TelegramProxy, keepAliveInterval?: number) {
    void keepAliveInterval;
    if (proxy && !("MTProxy" in proxy)) {
      throw new Error("Cloudflare Telegram TCP does not support SOCKS proxies");
    }
  }

  private resetReadSignal() {
    this.canRead = new Promise<boolean>((resolve) => {
      this.resolveRead = resolve;
    });
  }

  private wakeReadable(value: boolean) {
    this.resolveRead?.(value);
  }

  private fail(error: unknown) {
    this.terminalError = error instanceof Error ? error : new Error(String(error || "Cloudflare TCP failure"));
    this.closed = true;
    this.wakeReadable(false);
  }

  private consume(length: number) {
    if (length <= 0) return Buffer.alloc(0);
    const head = this.chunks[0];
    if (head && head.length - this.headOffset >= length) {
      const result = head.subarray(this.headOffset, this.headOffset + length);
      this.headOffset += length;
      this.available -= length;
      if (this.headOffset === head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      return result;
    }
    const result = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[0];
      if (!chunk) throw this.terminalError || closedError;
      const take = Math.min(chunk.length - this.headOffset, length - written);
      chunk.copy(result, written, this.headOffset, this.headOffset + take);
      written += take;
      this.headOffset += take;
      if (this.headOffset === chunk.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    this.available -= length;
    return result;
  }

  async connect(port: number, hostname: string) {
    this.chunks = [];
    this.headOffset = 0;
    this.available = 0;
    this.terminalError = null;
    this.resetReadSignal();
    const socket = connectTcp(
      { hostname, port },
      { allowHalfOpen: false, secureTransport: "off" },
    );
    this.socket = socket;
    try {
      await socket.opened;
      this.reader = socket.readable.getReader();
      this.writer = socket.writable.getWriter();
      this.closed = false;
      void this.receive();
      return this;
    } catch (error) {
      this.fail(error);
      try { socket.close(); } catch { /* Opening already failed. */ }
      throw error;
    }
  }

  private async receive() {
    try {
      while (!this.closed && this.reader) {
        const { done, value } = await this.reader.read();
        if (done) {
          this.closed = true;
          this.wakeReadable(false);
          return;
        }
        if (!value?.byteLength) continue;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        this.chunks.push(chunk);
        this.available += chunk.length;
        this.wakeReadable(true);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async readExactly(length: number) {
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const part = await this.read(remaining);
      parts.push(part);
      remaining -= part.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  async read(length: number) {
    if (this.available === 0) {
      if (this.closed) throw this.terminalError || closedError;
      await this.canRead;
    }
    if (this.available === 0) throw this.terminalError || closedError;
    const result = this.consume(Math.min(length, this.available));
    if (this.available === 0 && !this.closed) this.resetReadSignal();
    return result;
  }

  async readAll() {
    if (this.available === 0) {
      if (this.closed) throw this.terminalError || closedError;
      await this.canRead;
    }
    if (this.available === 0) throw this.terminalError || closedError;
    const result = this.consume(this.available);
    if (!this.closed) this.resetReadSignal();
    return result;
  }

  write(data: Buffer) {
    if (this.closed || !this.writer) throw this.terminalError || closedError;
    const copy = new Uint8Array(data.length);
    copy.set(data);
    void this.writer.write(copy).catch((error) => this.fail(error));
  }

  async close() {
    const socket = this.socket;
    this.closed = true;
    this.wakeReadable(false);
    this.socket = undefined;
    try { await this.reader?.cancel(); } catch { /* Socket may already be closed. */ }
    try { this.reader?.releaseLock(); } catch { /* Reader may already be released. */ }
    try { this.writer?.releaseLock(); } catch { /* Writer may already be released. */ }
    this.reader = undefined;
    this.writer = undefined;
    try { socket?.close(); } catch { /* Idempotent close. */ }
    try { await socket?.closed; } catch { /* Closing errors do not replace the request result. */ }
  }

  toString() {
    return "CloudflareTelegramSocket";
  }
}

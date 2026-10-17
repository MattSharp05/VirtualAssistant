// Main's connection to the JARVIS server (docs/TDD.md → Architecture; the renderer never talks to the
// server itself): a REST helper for the bridge's request(), and the live event stream (SSE at
// /api/desk/events) with the device key, reconnecting with backoff and catching up from Last-Event-ID.
// No Electron in here, so it's tested with a fake fetch and fake timers.
import type { ConnectionTest, DeskConnection, DeskEvent, MeResponse } from "@jarvis/shared";

export interface ConnectionConfig {
  serverUrl: string;
  deviceKey?: string;
}

export interface ConnectionOptions {
  config(): ConnectionConfig;
  onEvent(event: DeskEvent): void;
  onStatus?(status: DeskConnection): void;
  fetch?: typeof fetch;
  random?: () => number;
  /** A stream that sends nothing for this long is dead (the server sends a comment every 20 s). */
  idleMs?: number;
  requestTimeoutMs?: number;
}

/** 1 s, 2 s, 4 s… up to a minute, ±20% so a fleet of reconnects doesn't arrive in step. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export interface SseMessage {
  id?: string;
  data: string;
}

/** Splits a text/event-stream into messages (comments and unknown fields are ignored). */
export class SseParser {
  private buffer = "";

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const out: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) out.push({ ...(id === undefined ? {} : { id }), data: data.join("\n") });
    }
    return out;
  }
}

/** An HTTP error from the server, with its { error } message. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const NOT_PAIRED = "Not connected to JARVIS yet: add the server URL and paste a device key in Settings.";
const REVOKED =
  "The server doesn't know this device key (revoked or mistyped). Pair this Mac again from the dashboard.";

/** A failed fetch as a sentence: "Couldn't reach jarvis.example.ts.net (ECONNREFUSED)". */
export function describeFetchError(err: unknown, serverUrl: string): string {
  if (err instanceof ServerError) {
    if (err.status === 401) return REVOKED;
    if (err.status === 404) return `${serverUrl} answers, but it isn't a JARVIS server (no /api/desk).`;
    return `The server answered ${err.status}: ${err.message}`;
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return `${hostOf(serverUrl)} didn't answer in time.`;
  const why = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return `Couldn't reach ${hostOf(serverUrl)} (${why}).`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export class Connection {
  private state: DeskConnection = { state: "unconfigured" };
  private generation = 0;
  private abort?: AbortController;
  private wake?: () => void;
  private lastEventId?: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: ConnectionOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  get status(): DeskConnection {
    return { ...this.state };
  }

  /** Connects (or reconnects after the URL or key changed). */
  restart(): void {
    this.stop();
    const generation = ++this.generation;
    this.lastEventId = undefined;
    void this.run(generation);
  }

  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.wake?.();
  }

  /** A Desk API route: GET without a body, POST with one. Throws with the server's message. */
  async request<T = unknown>(path: string, body?: unknown): Promise<T> {
    const { serverUrl, deviceKey } = this.opts.config();
    if (!serverUrl || !deviceKey) throw new Error(NOT_PAIRED);
    const res = await this.fetch(`${serverUrl}/api/desk${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${deviceKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 30_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok)
      throw new ServerError(res.status, (json as { error?: string } | undefined)?.error ?? res.statusText);
    return json as T;
  }

  /** Settings → Test connection: who is this device, with the saved URL and key. */
  async test(): Promise<ConnectionTest> {
    const { serverUrl, deviceKey } = this.opts.config();
    if (!serverUrl) return { ok: false, error: "Add the server URL first." };
    if (!deviceKey) return { ok: false, error: "Paste a device key from the dashboard first." };
    try {
      const me = await this.request<MeResponse>("/me");
      // A working key while the stream is down (or was refused): try again now.
      if (this.state.state !== "connected" && this.state.state !== "connecting") this.restart();
      return { ok: true, deviceName: me.name };
    } catch (err) {
      return { ok: false, error: describeFetchError(err, serverUrl) };
    }
  }

  private setStatus(next: DeskConnection): void {
    this.state = next;
    this.opts.onStatus?.(this.status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private async run(generation: number): Promise<void> {
    let attempt = 0;
    while (generation === this.generation) {
      const { serverUrl, deviceKey } = this.opts.config();
      if (!serverUrl || !deviceKey) return this.setStatus({ state: "unconfigured" });
      this.setStatus({ ...this.state, state: "connecting", serverUrl, error: undefined });
      try {
        const me = await this.request<MeResponse>("/me");
        if (generation !== this.generation) return;
        await this.stream(generation, serverUrl, deviceKey, () => {
          attempt = 0;
          this.setStatus({ state: "connected", serverUrl, deviceName: me.name });
        });
        if (generation !== this.generation) return;
        throw new Error("the stream ended");
      } catch (err) {
        if (generation !== this.generation) return;
        if (err instanceof ServerError && err.status === 401) {
          // No point retrying a refused key; a new key (or Test connection) restarts.
          return this.setStatus({ state: "unauthorized", serverUrl, error: REVOKED });
        }
        this.setStatus({
          state: "offline",
          serverUrl,
          ...(this.state.deviceName ? { deviceName: this.state.deviceName } : {}),
          error: describeFetchError(err, serverUrl),
        });
        await this.sleep(backoffMs(attempt++, this.opts.random));
      }
    }
  }

  /** Reads the event stream until it ends, fails, goes quiet, or the connection is restarted. */
  private async stream(
    generation: number,
    serverUrl: string,
    deviceKey: string,
    onOpen: () => void,
  ): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error("the stream went quiet")), this.opts.idleMs ?? 60_000);
    };
    try {
      kick();
      const res = await this.fetch(`${serverUrl}/api/desk/events`, {
        headers: {
          authorization: `Bearer ${deviceKey}`,
          accept: "text/event-stream",
          ...(this.lastEventId ? { "last-event-id": this.lastEventId } : {}),
        },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new ServerError(res.status, res.statusText || "no stream");
      onOpen();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || generation !== this.generation) return;
        kick();
        for (const msg of parser.feed(decoder.decode(value, { stream: true }))) {
          if (msg.id) this.lastEventId = msg.id;
          try {
            const event = JSON.parse(msg.data) as Partial<DeskEvent> | null;
            // Only events (an object with a type) reach the windows (JD-63).
            if (event && typeof event === "object" && typeof event.type === "string")
              this.opts.onEvent(event as DeskEvent);
          } catch {
            // not an event we can read; skip it
          }
        }
      }
    } catch (err) {
      // A quiet stream aborts with its own reason; report that rather than "aborted".
      throw abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : err;
    } finally {
      clearTimeout(idle);
    }
  }
}

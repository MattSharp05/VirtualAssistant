// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskConnection, DeskEvent } from "@jarvis/shared";
import { backoffMs, Connection, SseParser, type ConnectionConfig } from "./connection";

const URL_ = "https://jarvis.tail1234.ts.net:8443";
const KEY = "jd_test_key_aaaaaaaaaaaaaaaaaaaa";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake server: /me answers with `me`; each /events call gets a stream the test can write to. */
function fakeServer(me: () => Response = () => json(200, { id: "d1", name: "Matthew's MacBook Pro" })) {
  const streams: { headers: Record<string, string>; push(s: string): void; end(): void }[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/desk/me")) return me();
    if (url.endsWith("/api/desk/events")) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      init?.signal?.addEventListener("abort", () => {
        try {
          controller.error(init.signal!.reason);
        } catch {
          // already closed
        }
      });
      streams.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        push: (s) => controller.enqueue(new TextEncoder().encode(s)),
        end: () => controller.close(),
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/api/desk/dnd")) return json(200, { on: true });
    return json(404, { error: "not found" });
  });
  return { fetch: fetchFn as unknown as typeof fetch, streams, calls };
}

function connect(
  server: ReturnType<typeof fakeServer>,
  config: ConnectionConfig = { serverUrl: URL_, deviceKey: KEY },
) {
  const events: DeskEvent[] = [];
  const statuses: DeskConnection[] = [];
  const conn = new Connection({
    config: () => config,
    fetch: server.fetch,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    random: () => 0.5,
    idleMs: 60_000,
  });
  return { conn, events, statuses, config };
}

afterEach(() => vi.useRealTimers());

describe("SseParser", () => {
  it("splits messages across chunks and skips comments", () => {
    const p = new SseParser();
    expect(p.feed(": connected\n\nid: 1\nda")).toEqual([]);
    expect(p.feed('ta: {"a":1}\n\n: ping\n\nid: 2\r\ndata: x\r\ndata: y\r\n\r\n')).toEqual([
      { id: "1", data: '{"a":1}' },
      { id: "2", data: "x\ny" },
    ]);
  });
});

describe("backoff", () => {
  it("doubles from a second up to a minute, with jitter", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 10].map((n) => backoffMs(n, mid))).toEqual([1000, 2000, 4000, 8000, 60_000]);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1200);
  });
});

describe("Connection", () => {
  it("connects with the device key, says who it is, and delivers events", async () => {
    const server = fakeServer();
    const { conn, events, statuses } = connect(server);
    conn.restart();
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    expect(server.streams[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(conn.status).toEqual({ state: "connected", serverUrl: URL_, deviceName: "Matthew's MacBook Pro" });
    server.streams[0].push(': connected\n\nid: 7\ndata: {"type":"orb.state","state":"thinking"}\n\n');
    await vi.waitFor(() => expect(events).toEqual([{ type: "orb.state", state: "thinking" }]));
    expect(statuses.map((s) => s.state)).toEqual(["connecting", "connected"]);
    conn.stop();
  });

  it("reconnects with backoff after the stream drops, catching up from Last-Event-ID", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = fakeServer();
    const { conn, statuses } = connect(server);
    conn.restart();
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    server.streams[0].push('id: 41\ndata: {"type":"tasks.changed"}\n\n');
    server.streams[0].end();
    // (vi.waitFor would move the fake clock on; settle the stream's promises by hand.)
    for (let i = 0; i < 50 && conn.status.state !== "offline"; i++) await Promise.resolve();
    expect(conn.status.state).toBe("offline");
    expect(conn.status.deviceName).toBe("Matthew's MacBook Pro");
    await vi.advanceTimersByTimeAsync(999);
    expect(server.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(server.streams).toHaveLength(2));
    expect(server.streams[1].headers["last-event-id"]).toBe("41");
    expect(statuses.at(-1)?.state).toBe("connected");
    conn.stop();
  });

  it("treats a stream that goes quiet as dropped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = fakeServer();
    const { conn } = connect(server);
    conn.restart();
    await vi.waitFor(() => expect(server.streams).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(conn.status.state).toBe("offline"));
    expect(conn.status.error).toMatch(/went quiet|reach/);
    conn.stop();
  });

  it("stops on a refused key instead of hammering the server", async () => {
    const server = fakeServer(() => json(401, { error: "unknown or revoked device key" }));
    const { conn } = connect(server);
    conn.restart();
    await vi.waitFor(() => expect(conn.status.state).toBe("unauthorized"));
    expect(conn.status.error).toMatch(/Pair this Mac again/);
    expect(server.streams).toHaveLength(0);
  });

  it("stays unconfigured without a URL or key", async () => {
    const server = fakeServer();
    const { conn } = connect(server, { serverUrl: URL_ });
    conn.restart();
    await vi.waitFor(() => expect(conn.status.state).toBe("unconfigured"));
    expect(server.calls).toHaveLength(0);
    await expect(conn.request("/me")).rejects.toThrow(/paste a device key/);
  });

  it("Test connection answers with the device name, or a reason", async () => {
    const ok = connect(fakeServer());
    expect(await ok.conn.test()).toEqual({ ok: true, deviceName: "Matthew's MacBook Pro" });
    ok.conn.stop();

    const refused = connect(fakeServer(() => json(401, { error: "unknown or revoked device key" })));
    expect(await refused.conn.test()).toEqual({ ok: false, error: expect.stringMatching(/revoked/) });

    const notJarvis = connect(fakeServer(() => json(404, { error: "not found" })));
    expect(await notJarvis.conn.test()).toEqual({
      ok: false,
      error: expect.stringMatching(/isn't a JARVIS server/),
    });

    const down = connect({
      ...fakeServer(),
      fetch: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    });
    expect(await down.conn.test()).toEqual({
      ok: false,
      error: "Couldn't reach jarvis.tail1234.ts.net:8443 (ECONNREFUSED).",
    });

    const noKey = connect(fakeServer(), { serverUrl: URL_ });
    expect(await noKey.conn.test()).toEqual({ ok: false, error: expect.stringMatching(/device key/) });
    const noUrl = connect(fakeServer(), { serverUrl: "" });
    expect(await noUrl.conn.test()).toEqual({ ok: false, error: "Add the server URL first." });
  });

  it("REST: GET without a body, POST JSON with one, the server's message on failure", async () => {
    const server = fakeServer();
    const { conn } = connect(server);
    expect(await conn.request("/dnd", { on: true })).toEqual({ on: true });
    const post = server.calls.at(-1)!;
    expect(post.init?.method).toBe("POST");
    expect(post.init?.body).toBe('{"on":true}');
    await expect(conn.request("/nope")).rejects.toThrow("not found");
  });
});

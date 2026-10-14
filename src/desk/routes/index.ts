// The Desk API router (docs/TDD.md → Desk API). Every file in this folder (except index.ts) default-
// exports a DeskRoute or an array of them and is loaded at startup, so a feature adds a file here and
// never edits this one. Every route needs a device key unless it says `public: true`.

import { readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DeviceInfo } from "@jarvis/shared";
import type { Brain } from "../../brain/index.js";
import type { EventBus } from "../../events.js";
import type { Jarvis } from "../../jarvis.js";
import type { DeviceStore } from "../auth.js";
import type { DeskRpc } from "../rpc.js";
import type { SseHub } from "../sse.js";

export interface DeskContext {
  jarvis: Jarvis;
  bus: EventBus;
  devices: DeviceStore;
  hub: SseHub;
  rpc: DeskRpc;
  /** The conversational brain (POST /api/desk/chat); absent in tests that don't need it. */
  brain?: Brain;
}

export interface DeskRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Path parameters from a `:name` pattern. */
  params: Record<string, string>;
  /** Parsed JSON body for POST/PUT/DELETE ({} when empty). */
  body: Record<string, unknown>;
  device?: DeviceInfo;
  ctx: DeskContext;
}

export interface DeskRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path under /api/desk, with `:name` parameters, e.g. "/rpc/:id". */
  path: string;
  public?: boolean;
  /** Return a value to send it as JSON (200), or write to `res` yourself and return undefined. */
  handler: (r: DeskRequest) => Promise<unknown> | unknown;
}

/** Thrown by handlers for a clean error status. */
export class DeskHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Compiled extends DeskRoute {
  pattern: RegExp;
  names: string[];
}

function compile(route: DeskRoute): Compiled {
  const names: string[] = [];
  const source = route.path.replace(/:([A-Za-z_]+)/g, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { ...route, pattern: new RegExp(`^/api/desk${source}$`), names };
}

export class DeskRouter {
  private readonly routes: Compiled[];

  constructor(routes: DeskRoute[]) {
    this.routes = routes.map(compile);
  }

  static async discover(dir = dirname(fileURLToPath(import.meta.url))): Promise<DeskRouter> {
    const routes: DeskRoute[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "index.js").sort()) {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: DeskRoute | DeskRoute[] };
      if (mod.default) routes.push(...(Array.isArray(mod.default) ? mod.default : [mod.default]));
    }
    return new DeskRouter(routes);
  }

  get size(): number {
    return this.routes.length;
  }

  /** Handles /api/desk/* requests. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: DeskContext,
    readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      let device: DeviceInfo | undefined;
      if (!route.public) {
        device = ctx.devices.verify(req.headers.authorization);
        if (!device) return sendJson(401, { error: "unknown or revoked device key" });
      }
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        let body: Record<string, unknown> = {};
        if (req.method !== "GET") {
          try {
            body = await readJson(req);
          } catch (err) {
            throw new DeskHttpError(400, (err as Error).message);
          }
        }
        const out = await route.handler({ req, res, url, params, body, device, ctx });
        if (out !== undefined && !res.headersSent) sendJson(200, out);
      } catch (err) {
        if (res.headersSent) return;
        if (err instanceof DeskHttpError) return sendJson(err.status, { error: err.message });
        console.error(`desk ${req.method} ${url.pathname} failed:`, err);
        return sendJson(500, { error: "internal error" });
      }
      return;
    }
    sendJson(pathMatched ? 405 : 404, { error: pathMatched ? "method not allowed" : "not found" });
  }
}

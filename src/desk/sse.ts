// The Desk's live stream (Server-Sent Events). Every event on the bus is numbered and kept in a short
// replay buffer, so a Desk that reconnects with Last-Event-ID gets what it missed. A comment line every
// 20 s keeps proxies (Tailscale Serve) from closing an idle stream.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeskEvent, StreamedEvent } from "@jarvis/shared";
import type { EventBus } from "../events.js";

const REPLAY = 200;
const HEARTBEAT_MS = 20_000;

export class SseHub {
  private nextId = 1;
  private readonly buffer: StreamedEvent[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly unsubscribe: () => void;

  constructor(bus: EventBus) {
    this.unsubscribe = bus.subscribe((event) => this.push(event));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private push(event: DeskEvent): void {
    const streamed = { id: this.nextId++, event };
    this.buffer.push(streamed);
    if (this.buffer.length > REPLAY) this.buffer.shift();
    for (const res of this.clients) write(res, streamed);
  }

  /** Serves one client until it disconnects. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    const last = Number(req.headers["last-event-id"] ?? NaN);
    if (Number.isFinite(last)) for (const e of this.buffer) if (e.id > last) write(res, e);
    this.clients.add(res);
    const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const done = () => {
      clearInterval(beat);
      this.clients.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  }

  close(): void {
    this.unsubscribe();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

function write(res: ServerResponse, e: StreamedEvent): void {
  res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.event)}\n\n`);
}

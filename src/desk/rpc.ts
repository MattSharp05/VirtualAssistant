// The server asking the Mac for something (a file from an allowed folder, the clipboard, a screenshot):
// an `rpc` event goes out on the live stream and the Desk answers with POST /api/desk/rpc/:id.

import { randomUUID } from "node:crypto";
import type { RpcAnswer } from "@jarvis/shared";
import type { EventBus } from "../events.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class DeskRpc {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly bus: EventBus,
    private readonly timeoutMs = 30_000,
  ) {}

  call(kind: string, payload: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Mac didn't answer (${kind}) within ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.bus.publish({ type: "rpc", id, kind, payload });
    });
  }

  /** The Desk's answer. False when the id is unknown (already answered or timed out). */
  answer(id: string, answer: RpcAnswer): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (answer.ok) p.resolve(answer.result);
    else p.reject(new Error(answer.error));
    return true;
  }
}

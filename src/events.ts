// The in-process event bus. Features publish DeskEvents (shared/protocol.ts); the Desk's live
// stream (JD-4) and other features subscribe. A throwing subscriber never stops the others.

import type { DeskEvent } from "@jarvis/shared";

export type Subscriber = (event: DeskEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(event: DeskEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        console.error(`event subscriber failed on ${event.type}:`, err);
      }
    }
  }
}

/** The process-wide bus. Tests create their own EventBus. */
export const bus = new EventBus();

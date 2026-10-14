// "Changed by JARVIS": every calendar write the brain makes (no confirm tap, ADR 0008) is logged
// with what the event looked like before, so it can be undone. Watches brain.onTool: a get_event
// earlier in the same turn is the `before` of a later update/delete of that event.

import { randomUUID } from "node:crypto";
import type { CalendarChange } from "@jarvis/shared";
import type { Brain, BrainToolEvent } from "./brain/index.js";
import type { EventBus } from "./events.js";
import { JarvisError } from "./jarvis.js";
import { JsonFile } from "./storage.js";
import { CALENDAR_WRITES, serverName } from "./tools/connectors.js";

const MAX_ENTRIES = 200;
const GET_EVENT = `${serverName("Google Calendar")}__get_event`;

const shortName = (tool: string) => tool.split("__").pop() ?? tool;
const eventIdOf = (input: unknown) => String((input as { eventId?: unknown } | undefined)?.eventId ?? "");

function describe(tool: string, input: Record<string, unknown>): string {
  const what = String(input.summary ?? input.eventId ?? "event");
  const when = input.startTime ? ` → ${String(input.startTime)}` : "";
  const rsvp = input.responseStatus ? ` → ${String(input.responseStatus)}` : "";
  return `${shortName(tool)}: ${what}${when}${rsvp}`;
}

export class CalendarLog {
  private readonly file: JsonFile<{ entries: CalendarChange[] }>;
  /** get_event results per turn (messageId → eventId → text). */
  private readonly seen = new Map<string, Map<string, string>>();
  /** An undo was handed to the brain; its next calendar write completes it. */
  private pendingUndo?: string;

  constructor(
    dataDir: string,
    private readonly bus?: EventBus,
  ) {
    this.file = new JsonFile(dataDir, "calendarLog", { entries: [] as CalendarChange[] });
  }

  attach(brain: Pick<Brain, "onTool">): () => void {
    return brain.onTool((e) => this.onTool(e));
  }

  /** Newest first. */
  recent(limit = 20): CalendarChange[] {
    return [...this.file.get().entries].reverse().slice(0, limit);
  }

  onTool(e: BrainToolEvent): void {
    if (e.phase !== "result" || e.isError) return;
    if (e.name === GET_EVENT) {
      const turn = this.seen.get(e.messageId) ?? new Map<string, string>();
      turn.set(eventIdOf(e.input), e.result ?? e.summary ?? "");
      this.seen.set(e.messageId, turn);
      // Keep only recent turns.
      if (this.seen.size > 20) this.seen.delete(this.seen.keys().next().value!);
      return;
    }
    if (!CALENDAR_WRITES.includes(e.name)) return;
    const input = (e.input ?? {}) as Record<string, unknown>;
    const entry: CalendarChange = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      tool: shortName(e.name),
      input,
      result: e.result ?? e.summary ?? "",
      summary: describe(e.name, input),
    };
    const before = this.seen.get(e.messageId)?.get(eventIdOf(input));
    if (before !== undefined && entry.tool !== "create_event") entry.before = before;
    const undoOf = this.pendingUndo;
    if (undoOf) {
      entry.undoOf = undoOf;
      this.pendingUndo = undefined;
    }
    void this.file.update((s) => ({
      entries: [...s.entries.map((x) => (x.id === undoOf ? { ...x, undoneAt: entry.at } : x)), entry].slice(-MAX_ENTRIES),
    }));
    this.bus?.publish({ type: "calendar.changed", entry });
  }

  /** The change to undo (latest not yet undone, or by id) and how; its next calendar write marks it undone. */
  undo(id?: string): { entry: CalendarChange; instructions: string } {
    const entries = this.recent(MAX_ENTRIES).filter((x) => !x.undoneAt && !x.undoOf);
    const entry = id ? entries.find((x) => x.id === id) : entries[0];
    if (!entry) throw new JarvisError(id ? `No calendar change ${id} to undo.` : "There's no calendar change of mine to undo.");
    this.pendingUndo = entry.id;
    const input = JSON.stringify(entry.input);
    const instructions =
      entry.tool === "create_event"
        ? `Delete the event it created (its id is in the result): ${entry.result.slice(0, 500)}`
        : entry.tool === "delete_event"
          ? `Re-create the deleted event with create_event from how it was before:\n${entry.before ?? "(no copy was saved; tell Matthew you can't restore its details)"}`
          : entry.tool === "update_event"
            ? `Call update_event on eventId ${String((entry.input as { eventId?: unknown }).eventId)} to restore the fields it changed (${input}) to their values before:\n${entry.before ?? "(no copy was saved; ask Matthew what to restore)"}`
            : `RSVP again with the response from before:\n${entry.before ?? "(unknown; ask Matthew)"}`;
    return { entry, instructions };
  }
}

const logs = new WeakMap<object, CalendarLog>();

export function useCalendarLog(owner: object, log: CalendarLog): void {
  logs.set(owner, log);
}

export function calendarLogFor(owner: object): CalendarLog {
  const log = logs.get(owner);
  if (!log) throw new JarvisError("The calendar log isn't running.");
  return log;
}

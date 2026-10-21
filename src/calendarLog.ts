// "Changed by JARVIS" (JD-14, JD-77): every calendar write JARVIS's own tools make is logged with
// what the event looked like before, so it can be undone. The calendar tools (src/tools/calendar.ts)
// call record() themselves right after a successful write — this no longer sniffs the brain's tool
// stream for a claude.ai connector's tool names (that connector kept dropping its write tools; JD-77
// replaced it with a first-party client the tools call directly, so logging can be direct too).

import { randomUUID } from "node:crypto";
import type { CalendarChange } from "@jarvis/shared";
import type { EventBus } from "./events.js";
import { JarvisError } from "./jarvis.js";
import { JsonFile } from "./storage.js";

const MAX_ENTRIES = 200;

export type CalendarWriteTool = "create_event" | "update_event" | "delete_event" | "respond";

export interface NewCalendarChange {
  tool: CalendarWriteTool;
  input: Record<string, unknown>;
  /** The tool's answer (the event after the change, or a confirmation), as text (often JSON). */
  result: string;
  /** A snapshot of the event before the change (update/delete/respond only), as text (often JSON). */
  before?: string;
  /** One line for the log, e.g. "update_event: Booking call → 2026-10-17T14:00:00". */
  summary: string;
}

export class CalendarLog {
  private readonly file: JsonFile<{ entries: CalendarChange[] }>;
  /** Set by undo_calendar_change just before it performs the reversal, so the next record() tags it. */
  private pendingUndo?: string;

  constructor(
    dataDir: string,
    private readonly bus?: EventBus,
  ) {
    this.file = new JsonFile(dataDir, "calendarLog", { entries: [] as CalendarChange[] });
  }

  /** Newest first. */
  recent(limit = 20): CalendarChange[] {
    return [...this.file.get().entries].reverse().slice(0, limit);
  }

  /** Called by a calendar tool right after a successful write. */
  async record(change: NewCalendarChange): Promise<CalendarChange> {
    const entry: CalendarChange = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...change };
    const undoOf = this.pendingUndo;
    this.pendingUndo = undefined;
    if (undoOf) entry.undoOf = undoOf;
    await this.file.update((s) => ({
      entries: [...s.entries.map((x) => (x.id === undoOf ? { ...x, undoneAt: entry.at } : x)), entry].slice(-MAX_ENTRIES),
    }));
    this.bus?.publish({ type: "calendar.changed", entry });
    return entry;
  }

  /** The change to undo (latest not yet undone and not itself an undo, or by id); throws if there's none. */
  pick(id?: string): CalendarChange {
    const entries = this.recent(MAX_ENTRIES).filter((x) => !x.undoneAt && !x.undoOf);
    const entry = id ? entries.find((x) => x.id === id) : entries[0];
    if (!entry) throw new JarvisError(id ? `No calendar change ${id} to undo.` : "There's no calendar change of mine to undo.");
    return entry;
  }

  /** Marks `id` as about to be undone; the next record() call tags itself as the reversal and marks `id` undone. */
  markPending(id: string): void {
    this.pendingUndo = id;
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

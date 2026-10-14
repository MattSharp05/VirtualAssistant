// Timers, reminders and background jobs. Timers and reminders are saved (DATA_DIR/timers.json), so
// they survive a restart; anything that came due while JARVIS was down fires on start, marked late.
// A one-second tick fires what's due; `every()` runs background jobs for later features.

import { randomUUID } from "node:crypto";
import type { EventBus } from "./events.js";
import { JarvisError } from "./jarvis.js";
import type { Notice } from "./notify.js";
import { JsonFile } from "./storage.js";

export interface ScheduledItem {
  id: string;
  kind: "timer" | "reminder";
  /** When it fires (UTC ISO). */
  at: string;
  createdAt: string;
  /** Timer label or reminder text. */
  text?: string;
}

export interface SchedulerOptions {
  bus: EventBus;
  notify: (n: Notice) => Promise<void>;
  now?: () => number;
  tickMs?: number;
}

/** Anything more than this past due when JARVIS starts is "late". */
const LATE_MS = 5_000;

/** "14:32" (or "Fri 17 Oct 09:00" when it's not today) in the server's time zone (TZ). */
export function clock(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export class Scheduler {
  private readonly file: JsonFile<{ items: ScheduledItem[] }>;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private readonly jobs = new Map<string, NodeJS.Timeout>();

  constructor(
    dataDir: string,
    private readonly opts: SchedulerOptions,
  ) {
    this.file = new JsonFile(dataDir, "timers", { items: [] as ScheduledItem[] });
    this.now = opts.now ?? Date.now;
  }

  /** Fires anything missed while JARVIS was down (marked late), then ticks every second. */
  start(): void {
    this.tick(true);
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const t of this.jobs.values()) clearInterval(t);
    this.jobs.clear();
  }

  /** A time as Matthew reads it, relative to this scheduler's clock. */
  clock(iso: string): string {
    return clock(iso, this.now());
  }

  list(): ScheduledItem[] {
    return [...this.file.get().items].sort((a, b) => a.at.localeCompare(b.at));
  }

  setTimer(minutes: number, label?: string): ScheduledItem {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new JarvisError("A timer is between a few seconds and 24 hours.");
    const item = this.add("timer", new Date(this.now() + minutes * 60_000).toISOString(), label?.trim() || undefined);
    this.opts.bus.publish({ type: "timer.started", id: item.id, endsAt: item.at, ...(item.text ? { label: item.text } : {}) });
    return item;
  }

  setReminder(at: string, text: string): ScheduledItem {
    // Strict ISO only: Date.parse would read "Friday at 9" as a date in 2001.
    const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at.trim()) ? Date.parse(at) : NaN;
    if (Number.isNaN(when)) throw new JarvisError(`"${at}" isn't a date and time (use ISO, e.g. 2026-10-17T09:00:00+01:00).`);
    if (when <= this.now()) throw new JarvisError(`${clock(new Date(when).toISOString(), this.now())} has already passed.`);
    if (!text.trim()) throw new JarvisError("A reminder needs some text.");
    return this.add("reminder", new Date(when).toISOString(), text.trim());
  }

  cancel(id: string): ScheduledItem {
    const item = this.file.get().items.find((i) => i.id === id || i.id.startsWith(id));
    if (!item) throw new JarvisError(`No timer or reminder ${id}.`);
    void this.file.update((s) => ({ items: s.items.filter((i) => i.id !== item.id) }));
    return item;
  }

  /** Runs `fn` every `intervalMs` (background jobs); errors are logged, never thrown. Returns a stop function. */
  every(name: string, intervalMs: number, fn: () => Promise<void> | void): () => void {
    clearInterval(this.jobs.get(name));
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error(`background job ${name} failed:`, err));
    }, intervalMs);
    t.unref();
    this.jobs.set(name, t);
    return () => {
      clearInterval(t);
      this.jobs.delete(name);
    };
  }

  /** Fires everything due. `starting` marks items that were missed while down as late. */
  tick(starting = false): void {
    const now = this.now();
    const due = this.file.get().items.filter((i) => Date.parse(i.at) <= now);
    if (!due.length) return;
    void this.file.update((s) => ({ items: s.items.filter((i) => !due.some((d) => d.id === i.id)) }));
    for (const item of due) this.fire(item, starting && now - Date.parse(item.at) > LATE_MS);
  }

  private add(kind: ScheduledItem["kind"], at: string, text?: string): ScheduledItem {
    const item: ScheduledItem = { id: randomUUID().slice(0, 8), kind, at, createdAt: new Date(this.now()).toISOString(), ...(text ? { text } : {}) };
    void this.file.update((s) => ({ items: [...s.items, item] }));
    return item;
  }

  private fire(item: ScheduledItem, late: boolean): void {
    const lateNote = late ? `(late: was due ${clock(item.at, this.now())})` : undefined;
    if (item.kind === "timer") {
      this.opts.bus.publish({ type: "timer.done", id: item.id, ...(item.text ? { label: item.text } : {}) });
      void this.opts.notify({ title: `⏰ Timer done${item.text ? `: ${item.text}` : ""}`, body: lateNote, telegram: true });
    } else {
      this.opts.bus.publish({ type: "reminder.due", id: item.id, text: item.text ?? "", late });
      void this.opts.notify({ title: `🔔 ${item.text ?? "Reminder"}`, body: lateNote, telegram: true });
    }
  }
}

/** The process's scheduler, registered by index.ts (keyed by the JARVIS instance, so tests get their own). */
const schedulers = new WeakMap<object, Scheduler>();

export function useScheduler(owner: object, scheduler: Scheduler): void {
  schedulers.set(owner, scheduler);
}

export function schedulerFor(owner: object): Scheduler {
  const s = schedulers.get(owner);
  if (!s) throw new JarvisError("Timers aren't running.");
  return s;
}

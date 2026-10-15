// Calendar events for any range up to 42 days (JD-21; the Calendar window, mockup 10), fetched by
// the worker brain through the Google Calendar connector and kept for 10 minutes. CalendarCache
// dedupes concurrent requests (one job per range), answers from a fresh copy that covers the range,
// and forgets everything when JARVIS changes the calendar (calendar.changed, JD-14).
import type { CalendarAttendee, CalendarEvent, CalendarEventKind, CalendarRange, CalendarResponse, FreeSlot } from "@jarvis/shared";
import type { EventBus } from "../events.js";
import { freeSlots, localIso } from "../freeSlots.js";
import { JarvisError } from "../jarvis.js";
import { jobRunnerFor, type JobDef, type JobParams, type JobResult } from "./index.js";

export const CALENDAR_JOB = "calendarRange";
export const MAX_RANGE_DAYS = 42;
export const CACHE_MS = 10 * 60_000;

const MAX_EVENTS = 500;
const KINDS: CalendarEventKind[] = ["work", "personal", "focus"];
const RESPONSES: CalendarAttendee["response"][] = ["accepted", "declined", "tentative", "needsAction"];
const str = (description: string) => ({ type: "string", description });

const fail = (why: string): never => {
  throw new JarvisError(`submit_events rejected: ${why}. Fix it and call submit_events again.`);
};
const text = (v: unknown, field: string, optional = false, max = 300): string | undefined => {
  if (v === undefined || v === null || v === "") return optional ? undefined : fail(`${field} is required`);
  if (typeof v !== "string") return fail(`${field} must be a string`);
  return v.slice(0, max);
};
const list = (v: unknown, field: string): Record<string, unknown>[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail(`${field} must be a list`);
  return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
};
const time = (v: unknown, field: string): string => {
  const t = text(v, field)!;
  return Number.isNaN(Date.parse(t)) ? fail(`${field} must be an ISO date or time`) : t;
};
const opt = <K extends string, V>(key: K, value: V | undefined) => (value !== undefined ? { [key]: value } : {}) as Partial<Record<K, V>>;

/** Focus blocks by title; otherwise the worker's call, else "work" if the calendar says so, else personal. */
export function kindOf(title: string, calendarId: string, given?: unknown): CalendarEventKind {
  if (/\b(focus|block(ed)?)\b/i.test(title)) return "focus";
  if (KINDS.includes(given as CalendarEventKind)) return given as CalendarEventKind;
  return /work/i.test(calendarId) ? "work" : "personal";
}

export function validateEvents(input: unknown): CalendarRange {
  if (!input || typeof input !== "object") return fail("send an object");
  const i = input as Record<string, unknown>;
  const r = (i.range ?? {}) as Record<string, unknown>;
  const range = { start: time(r.start, "range.start"), end: time(r.end, "range.end") };
  const events: CalendarEvent[] = list(i.events, "events").slice(0, MAX_EVENTS).map((e, n) => {
    const start = time(e.start, `events[${n}].start`);
    const title = text(e.title, `events[${n}].title`, true) ?? "(No title)";
    const calendarId = text(e.calendarId, `events[${n}].calendarId`, true) ?? "primary";
    const attendees: CalendarAttendee[] = list(e.attendees, `events[${n}].attendees`).slice(0, 50).map((a, k) => ({
      name: text(a.name, `attendees[${k}].name`, true) ?? "",
      email: text(a.email, `events[${n}].attendees[${k}].email`)!,
      response: RESPONSES.includes(a.response as CalendarAttendee["response"]) ? (a.response as CalendarAttendee["response"]) : "needsAction",
    }));
    return {
      id: text(e.id, `events[${n}].id`)!,
      calendarId,
      start,
      end: time(e.end, `events[${n}].end`),
      allDay: typeof e.allDay === "boolean" ? e.allDay : /^\d{4}-\d{2}-\d{2}$/.test(start),
      title,
      ...opt("location", text(e.location, "location", true)),
      ...opt("attendees", attendees.length ? attendees : undefined),
      ...opt("description", text(e.description, "description", true, 1000)),
      ...opt("link", text(e.link, "link", true)),
      kind: kindOf(title, calendarId, e.kind),
    };
  });
  const free: FreeSlot[] = list(i.free, "free").map((f, n) => ({ start: time(f.start, `free[${n}].start`), end: time(f.end, `free[${n}].end`) }));
  return { range, events: events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), ...opt("free", free.length ? free : undefined) };
}

const job: JobDef<CalendarRange, CalendarRange> = {
  name: CALENDAR_JOB,
  submitTool: {
    name: "submit_events",
    description: "Hand back the calendar events for the requested range (worker only). Call exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "object", description: "The range you were asked for, as given", properties: { start: str("ISO start"), end: str("ISO end") }, required: ["start", "end"] },
        events: {
          type: "array",
          description: "Every event in the range, across Matthew's calendars",
          items: {
            type: "object",
            properties: {
              id: str("Event id"),
              calendarId: str("Calendar id"),
              start: str("ISO start (a YYYY-MM-DD date for all-day events)"),
              end: str("ISO end (for all-day events, the day after the last day)"),
              allDay: { type: "boolean", description: "An all-day event" },
              title: str("Title"),
              location: str("Where (optional)"),
              attendees: {
                type: "array",
                description: "Guests (optional)",
                items: {
                  type: "object",
                  properties: { name: str("Display name"), email: str("Email"), response: { type: "string", enum: RESPONSES } },
                  required: ["email", "response"],
                },
              },
              description: str("Description, first 1000 characters (optional)"),
              link: str("Meeting link, else the event's Google Calendar link (optional)"),
              kind: { type: "string", enum: KINDS, description: "focus: focus time/blocks · work: his work calendar · personal: anything else" },
            },
            required: ["id", "calendarId", "start", "end", "allDay", "title", "kind"],
          },
        },
        free: {
          type: "array",
          description: "Leave out: the server works out free time itself",
          items: { type: "object", properties: { start: str("ISO start"), end: str("ISO end") }, required: ["start", "end"] },
        },
      },
      required: ["range", "events"],
    },
  },
  prompt: (_now, _ctx, params) => {
    const tz = process.env.TZ || "UTC";
    return [
      `Fetch Matthew's calendar events from ${params?.start} to ${params?.end} (his time zone: ${tz}).`,
      "1. list_calendars, then list_events for that range on each calendar he owns or has selected (skip holiday/birthday calendars). Page through every result; leave out cancelled events.",
      "2. For each event: id, calendarId, start and end as the calendar gives them (all-day events: dates, allDay true), title, location, attendees (name, email, response), the first 1000 characters of the description, and a link (the video-call link if there is one, else the event's htmlLink).",
      '3. kind: "focus" if the title says focus or block; "work" if it is on his work calendar (the calendar\'s name or account is his work one); otherwise "personal".',
      `4. Call submit_events once with range { start: "${params?.start}", end: "${params?.end}" } and the events. If the calendar isn't connected or fails, submit an empty list.`,
    ].join("\n");
  },
  validate: validateEvents,
  // The range is what was asked for (the cache's key); free time is worked out here, not by the model.
  finish: async (data, _ctx, _now, params) => {
    const range = params?.start && params.end ? { start: params.start, end: params.end } : data.range;
    return { range, events: data.events, free: freeSlots(data.events, { from: new Date(range.start), to: new Date(range.end) }) };
  },
};

export default job;

// ── The cache ──

type Fetch = (range: JobParams) => Promise<{ result?: JobResult<CalendarRange>; error?: string }>;

interface Entry {
  at: number;
  from: number;
  to: number;
  data: CalendarRange;
}

const keyOf = (from: Date, to: Date) => `${from.getTime()}|${to.getTime()}`;
const overlaps = (e: CalendarEvent, from: number, to: number) => Date.parse(e.start) < to && Date.parse(e.end) > from;

export class CalendarCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CalendarResponse>>();
  /** Bumped on invalidate, so a job that started before a change doesn't refill the cache. */
  private generation = 0;

  constructor(
    private readonly fetch: Fetch,
    bus?: EventBus,
    private readonly now: () => number = Date.now,
  ) {
    bus?.subscribe((e) => {
      if (e.type === "calendar.changed") this.invalidate();
    });
  }

  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
  }

  /** Events for [from, to): a copy < 10 min old (exact, or one that covers it), else a worker job. */
  get(from: Date, to: Date, rangeIso: { start: string; end: string }): Promise<CalendarResponse> {
    const key = keyOf(from, to);
    const fresh = this.fresh(from.getTime(), to.getTime());
    if (fresh) return Promise.resolve(fresh);
    const running = this.inflight.get(key);
    if (running) return running;
    const generation = this.generation;
    const p = this.load(key, from, to, rangeIso, generation).finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private fresh(from: number, to: number): CalendarResponse | undefined {
    const now = this.now();
    const exact = this.entries.get(`${from}|${to}`);
    const entry = exact && now - exact.at < CACHE_MS ? exact : [...this.entries.values()].find((x) => now - x.at < CACHE_MS && x.from <= from && x.to >= to);
    if (!entry) return undefined;
    const ageSeconds = Math.round((now - entry.at) / 1000);
    if (entry === exact) return { ...entry.data, ageSeconds };
    const events = entry.data.events.filter((e) => overlaps(e, from, to));
    return { range: { start: localIso(new Date(from)), end: localIso(new Date(to)) }, events, free: freeSlots(events, { from: new Date(from), to: new Date(to) }), ageSeconds };
  }

  private async load(key: string, from: Date, to: Date, rangeIso: { start: string; end: string }, generation: number): Promise<CalendarResponse> {
    const { result, error } = await this.fetch(rangeIso);
    const ok = result && !error && result.data.range.start === rangeIso.start && result.data.range.end === rangeIso.end;
    if (!ok) {
      const last = this.entries.get(key);
      if (last) return { ...last.data, ageSeconds: Math.round((this.now() - last.at) / 1000), stale: true, ...opt("lastError", error) };
      throw new JarvisError(`Couldn't fetch the calendar: ${error ?? "no result"}`);
    }
    const entry: Entry = { at: this.now(), from: from.getTime(), to: to.getTime(), data: result.data };
    if (generation === this.generation) {
      // Forget copies too old to serve (an exact one stays as the fallback if a refresh fails).
      for (const [k, x] of this.entries) if (entry.at - x.at >= 6 * CACHE_MS) this.entries.delete(k);
      this.entries.set(key, entry);
    }
    return { ...entry.data, ageSeconds: 0 };
  }
}

const caches = new WeakMap<object, CalendarCache>();

export function useCalendarCache(owner: object, cache: CalendarCache): void {
  caches.set(owner, cache);
}

/** Runs the calendarRange job on this JARVIS's worker (a failed run reports its error). */
export function runnerFetch(owner: object): Fetch {
  return async (range) => {
    const runner = jobRunnerFor(owner);
    const result = (await runner.run(CALENDAR_JOB, range)) as JobResult<CalendarRange> | undefined;
    return { result, error: runner.lastError(CALENDAR_JOB) || undefined };
  };
}

/** The cache for this JARVIS (made on first use, listening on `bus` for calendar changes). */
export function calendarCacheFor(owner: object, bus?: EventBus): CalendarCache {
  let cache = caches.get(owner);
  if (!cache) {
    cache = new CalendarCache(runnerFetch(owner), bus);
    caches.set(owner, cache);
  }
  return cache;
}

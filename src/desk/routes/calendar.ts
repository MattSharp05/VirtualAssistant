// The Calendar window's data:
//   GET  /api/desk/calendar?start=&end=            → CalendarResponse (≤ 42 days; cached 10 min, JD-21)
//   POST /api/desk/calendar/refresh {start?, end?} → drops the cache; with a range, fetches it again
//   GET  /api/desk/calendar/free?days=7&minMinutes=30 → free slots in working hours from today
//   GET  /api/desk/calendar/log                    → the last 20 calendar changes JARVIS made (newest first)
// `start`/`end` are ISO times or dates (YYYY-MM-DD, Matthew's time zone); a date `end` includes that day.
import type { CalendarChange, CalendarFreeResponse, CalendarResponse } from "@jarvis/shared";
import { calendarLogFor } from "../../calendarLog.js";
import { freeSlots, localIso, startOfDay } from "../../freeSlots.js";
import { JarvisError } from "../../jarvis.js";
import { calendarCacheFor, MAX_RANGE_DAYS } from "../../jobs/calendarRange.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function when(value: unknown, field: string, isEnd: boolean): Date {
  if (typeof value !== "string" || !value) throw new DeskHttpError(400, `${field} is required`);
  const d = DATE.exec(value);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + (isEnd ? 1 : 0));
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new DeskHttpError(400, `${field} must be a date (YYYY-MM-DD) or an ISO time`);
  return new Date(t);
}

function rangeOf(start: unknown, end: unknown): { from: Date; to: Date } {
  const from = when(start, "start", false);
  const to = when(end, "end", true);
  if (to <= from) throw new DeskHttpError(400, "end must be after start");
  // A day of slack for a clock change inside the range.
  if (to.getTime() - from.getTime() > (MAX_RANGE_DAYS * 24 + 1) * 3_600_000) throw new DeskHttpError(400, `the range can be at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

async function events(ctx: DeskContext, from: Date, to: Date): Promise<CalendarResponse> {
  try {
    return await calendarCacheFor(ctx.jarvis, ctx.bus).get(from, to, { start: localIso(from), end: localIso(to) });
  } catch (err) {
    if (err instanceof JarvisError) throw new DeskHttpError(502, err.message);
    throw err;
  }
}

function number(value: string | null, fallback: number, min: number, max: number, field: string): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new DeskHttpError(400, `${field} must be a whole number from ${min} to ${max}`);
  return n;
}

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/calendar",
    handler: async ({ ctx, url }) => {
      const { from, to } = rangeOf(url.searchParams.get("start"), url.searchParams.get("end"));
      return events(ctx, from, to);
    },
  },
  {
    method: "POST",
    path: "/calendar/refresh",
    handler: async ({ ctx, url, body }) => {
      calendarCacheFor(ctx.jarvis, ctx.bus).invalidate();
      const start = body.start ?? url.searchParams.get("start");
      const end = body.end ?? url.searchParams.get("end");
      if (!start && !end) return { cleared: true };
      const { from, to } = rangeOf(start, end);
      return events(ctx, from, to);
    },
  },
  {
    method: "GET",
    path: "/calendar/free",
    handler: async ({ ctx, url }): Promise<CalendarFreeResponse> => {
      const days = number(url.searchParams.get("days"), 7, 1, MAX_RANGE_DAYS, "days");
      const minMinutes = number(url.searchParams.get("minMinutes"), 30, 5, 600, "minMinutes");
      const now = new Date();
      const to = startOfDay(now, days);
      // Whole days, so the cached range stays the same all day.
      const cal = await events(ctx, startOfDay(now), to);
      return { from: localIso(now), to: localIso(to), minMinutes, slots: freeSlots(cal.events, { from: now, to, minMinutes }), ageSeconds: cal.ageSeconds };
    },
  },
  {
    method: "GET",
    path: "/calendar/log",
    handler: ({ ctx }): { changes: CalendarChange[] } => ({ changes: calendarLogFor(ctx.jarvis).recent(20) }),
  },
];

export default routes;

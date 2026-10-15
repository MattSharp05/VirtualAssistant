// Free time in Matthew's working hours (JD-21), from calendar events: 09:00–18:00 his time (TZ),
// weekdays only. Timed events are busy (overlaps merged); all-day events don't block time, as in
// Google Calendar, where they show as "free" by default (holidays, birthdays, "office day").
import type { FreeSlot } from "@jarvis/shared";

export interface FreeSlotOptions {
  from: Date;
  to: Date;
  /** Shortest slot worth offering (default 30). */
  minMinutes?: number;
  /** Working hours, local time (default 9 to 18). */
  dayStart?: number;
  dayEnd?: number;
}

const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");

/** An ISO time with the local (TZ) offset, e.g. 2026-10-12T09:00:00+01:00. */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date}T${time}${off < 0 ? "-" : "+"}${pad(off / 60)}:${pad(off % 60)}`;
}

/** Local midnight of the day `d` falls on, `addDays` later (DST-safe). */
export function startOfDay(d: Date, addDays = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays);
}

export function freeSlots(events: { start: string; end: string; allDay?: boolean }[], opts: FreeSlotOptions): FreeSlot[] {
  const minMs = (opts.minMinutes ?? 30) * 60_000;
  const busy = events
    .filter((e) => !e.allDay)
    .map((e) => [Date.parse(e.start), Date.parse(e.end)] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of busy) {
    const last = merged.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const slots: FreeSlot[] = [];
  const push = (s: number, e: number) => {
    if (e - s >= minMs) slots.push({ start: localIso(new Date(s)), end: localIso(new Date(e)) });
  };
  for (let day = startOfDay(opts.from); day < opts.to; day = startOfDay(day, 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const at = (hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime();
    let cursor = Math.max(at(opts.dayStart ?? 9), opts.from.getTime());
    const end = Math.min(at(opts.dayEnd ?? 18), opts.to.getTime());
    for (const [s, e] of merged) {
      if (e <= cursor || s >= end) continue;
      push(cursor, Math.min(s, end));
      cursor = Math.max(cursor, e);
    }
    if (cursor < end) push(cursor, end);
  }
  return slots;
}

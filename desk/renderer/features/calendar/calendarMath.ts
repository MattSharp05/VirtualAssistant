// The Calendar window's maths (JD-35): which days a view shows, where each event sits in the time
// grid (overlaps side by side), the month grid, and the text JARVIS is sent. Pure, so it's unit tested.
import type { CalendarChange, CalendarEvent, FreeSlot } from "@jarvis/shared";

export type CalendarView = "day" | "week" | "month";

/** Height of one hour in the day and week grids. */
export const HOUR_PX = 52;
/** The working day the grid opens on; earlier and later hours are a scroll away. */
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 19;
/** Short events still get room for their title. */
export const MIN_EVENT_PX = 20;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An event time: dates (all-day events) are local midnight, everything else an ISO time. */
export function parseTime(value: string): Date {
  const d = DATE_ONLY.exec(value);
  return d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])) : new Date(value);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Weeks start on Monday. */
export function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** YYYY-MM-DD in local time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Wed 14 Oct". */
export function shortDay(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]!.slice(0, 3)}`;
}

export function weekdayName(d: Date): string {
  return DAYS[d.getDay()]!;
}

export interface VisibleRange {
  start: Date;
  days: number;
}

/** The days a view shows around `anchor`: one day, Mon–Sun, or the whole weeks covering the month. */
export function visibleRange(view: CalendarView, anchor: Date): VisibleRange {
  if (view === "day") return { start: startOfDay(anchor), days: 1 };
  if (view === "week") return { start: startOfWeek(anchor), days: 7 };
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 7);
  return { start, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

/** The query for GET /calendar: dates, with `end` the last day shown (the server includes it). */
export function rangeQuery({ start, days }: VisibleRange): string {
  return `start=${ymd(start)}&end=${ymd(addDays(start, days - 1))}`;
}

/** Previous (-1) or next (+1) day, week or month. */
export function shift(view: CalendarView, anchor: Date, dir: -1 | 1): Date {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

/** "12 – 18 October 2026", "28 Sep – 4 Oct 2026", "Wednesday 14 October 2026", "October 2026". */
export function rangeLabel(view: CalendarView, anchor: Date): string {
  const month = (d: Date) => MONTHS[d.getMonth()]!;
  if (view === "day")
    return `${LONG_DAYS[anchor.getDay()]} ${anchor.getDate()} ${month(anchor)} ${anchor.getFullYear()}`;
  if (view === "month") return `${month(anchor)} ${anchor.getFullYear()}`;
  const a = startOfWeek(anchor);
  const b = addDays(a, 6);
  if (a.getFullYear() !== b.getFullYear())
    return `${a.getDate()} ${month(a).slice(0, 3)} ${a.getFullYear()} – ${b.getDate()} ${month(b).slice(0, 3)} ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth())
    return `${a.getDate()} ${month(a).slice(0, 3)} – ${b.getDate()} ${month(b).slice(0, 3)} ${b.getFullYear()}`;
  return `${a.getDate()} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`;
}

/** Google Calendar's own page for the same view. */
export function googleCalendarUrl(view: CalendarView, anchor: Date): string {
  return `https://calendar.google.com/calendar/r/${view}/${anchor.getFullYear()}/${anchor.getMonth() + 1}/${anchor.getDate()}`;
}

/** "09:30 – 09:45", or "All day". */
export function timeSpan(e: CalendarEvent): string {
  return e.allDay ? "All day" : `${hhmm(parseTime(e.start))} – ${hhmm(parseTime(e.end))}`;
}

/** All-day events (and anything that runs a whole day) touching `day`. */
export function allDayOn(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  return events.filter(
    (e) => e.allDay && parseTime(e.start).getTime() < to && parseTime(e.end).getTime() > from,
  );
}

/** A timed event's part inside one day, in minutes from midnight. */
export interface Segment {
  event: CalendarEvent;
  startMin: number;
  endMin: number;
}

/** Timed events overlapping `day`, clipped to it (an event past midnight shows on both days). */
export function segmentsOn(events: CalendarEvent[], day: Date): Segment[] {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  return events
    .filter((e) => !e.allDay)
    .flatMap((event) => {
      const s = parseTime(event.start).getTime();
      const e = Math.max(parseTime(event.end).getTime(), s);
      if (s >= to || e <= from || (e === s && (s < from || s >= to))) return [];
      return [
        {
          event,
          startMin: Math.round((Math.max(s, from) - from) / 60_000),
          endMin: Math.round((Math.min(e, to) - from) / 60_000),
        },
      ];
    });
}

export interface Placed extends Segment {
  /** Column inside its group of overlapping events, and how many columns that group has. */
  column: number;
  columns: number;
}

/**
 * Overlapping events side by side: events that overlap (directly or through a chain) form a group;
 * each takes the first column free at its start, and the group's width is split between its columns.
 */
export function layoutDay(segments: Segment[]): Placed[] {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let colEnds: number[] = [];
  let groupEnd = -1;
  const close = () => {
    for (const p of group) p.columns = colEnds.length;
    group = [];
    colEnds = [];
  };
  for (const seg of sorted) {
    // A zero-length event still takes a sliver, so it can't share a column with what starts then.
    const end = Math.max(seg.endMin, seg.startMin + 1);
    if (seg.startMin >= groupEnd) close();
    let column = colEnds.findIndex((e) => e <= seg.startMin);
    if (column === -1) column = colEnds.push(end) - 1;
    else colEnds[column] = end;
    const p: Placed = { ...seg, column, columns: 1 };
    group.push(p);
    placed.push(p);
    groupEnd = Math.max(groupEnd, end);
  }
  close();
  return placed;
}

/**
 * The hours the grid covers: 08:00–19:00, widened to whole hours around any earlier or later event so
 * it is reachable by scrolling. `scrollTop` puts 08:00 at the top.
 */
export function gridHours(segments: Segment[]): { from: number; to: number; scrollTop: number } {
  let from = DAY_START_HOUR;
  let to = DAY_END_HOUR;
  for (const s of segments) {
    from = Math.min(from, Math.floor(s.startMin / 60));
    to = Math.max(to, Math.ceil(s.endMin / 60));
  }
  return { from, to, scrollTop: (DAY_START_HOUR - from) * HOUR_PX };
}

/** Where a placed event sits in a grid that starts at `fromHour`: px from the top, % across. */
export function boxOf(
  p: Placed,
  fromHour: number,
): { top: number; height: number; left: number; width: number } {
  return {
    top: ((p.startMin - fromHour * 60) / 60) * HOUR_PX,
    height: Math.max(MIN_EVENT_PX, ((p.endMin - p.startMin) / 60) * HOUR_PX - 2),
    left: (p.column / p.columns) * 100,
    width: 100 / p.columns,
  };
}

/** The now-line's offset in a grid starting at `fromHour`. */
export function nowOffset(now: Date, fromHour: number): number {
  return ((now.getHours() * 60 + now.getMinutes() - fromHour * 60) / 60) * HOUR_PX;
}

export interface MonthDay {
  date: Date;
  inMonth: boolean;
  events: CalendarEvent[];
}

/** The month view's cells, week by week: all-day events first, then by start time. */
export function monthWeeks(anchor: Date, events: CalendarEvent[]): MonthDay[][] {
  const { start, days } = visibleRange("month", anchor);
  const cells = Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const dayEvents = [...allDayOn(events, date), ...segmentsOn(events, date).map((s) => s.event)];
    return {
      date,
      inMonth: date.getMonth() === anchor.getMonth(),
      events: dayEvents.sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) || parseTime(a.start).getTime() - parseTime(b.start).getTime(),
      ),
    };
  });
  return Array.from({ length: days / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** "Thu 13:00 – 15:00" for a free slot. */
export function slotLabel(slot: FreeSlot): string {
  const s = parseTime(slot.start);
  return `${weekdayName(s)} ${hhmm(s)} – ${hhmm(parseTime(slot.end))}`;
}

/** The first Notion page linked from an event's description ("Open in Notion"). */
export function notionLink(description: string | undefined): string | undefined {
  return description?.match(
    /https:\/\/(?:[\w-]+\.)*(?:notion\.so|notion\.site|notion\.com)\/[^\s)<>"']*/,
  )?.[0];
}

// ── Changed by JARVIS ──

const VERBS: Record<string, string> = {
  create_event: "Created",
  update_event: "Changed",
  delete_event: "Deleted",
  // "respond" (JD-77, JARVIS's own tool); "respond_to_event" kept for log entries written before it.
  respond: "Answered",
  respond_to_event: "Answered",
};

/**
 * One log line, from the server's summary ("update_event: Booking call → 2026-10-16T12:00:00"):
 * "Moved “Booking call” → Fri 16 Oct 12:00".
 */
export function describeChange(change: CalendarChange): string {
  const m = /^(\w+): (.*?)(?: → (.*))?$/.exec(change.summary);
  if (!m) return change.summary;
  const [, tool, what, to] = m;
  const time = to && !Number.isNaN(Date.parse(to)) ? parseTime(to) : undefined;
  const target = time ? `${shortDay(time)} ${hhmm(time)}` : to;
  const verb = tool === "update_event" && time ? "Moved" : (VERBS[tool!] ?? tool);
  const line = `${verb} “${what}”${target ? ` → ${target}` : ""}`;
  return change.undoOf ? `Undo: ${line}` : line;
}

/** When a change happened: "09:07" today, "Mon 18:20" before. */
export function changeTime(change: CalendarChange, now: Date): string {
  const at = new Date(change.at);
  return sameDay(at, now) ? hhmm(at) : `${weekdayName(at)} ${hhmm(at)}`;
}

/** The change "undo that" undoes: the newest that isn't undone and isn't itself an undo. */
export function latestUndoable(changes: CalendarChange[]): CalendarChange | undefined {
  return [...changes].sort((a, b) => b.at.localeCompare(a.at)).find((c) => !c.undoneAt && !c.undoOf);
}

/**
 * Merges log entries by id (`fresh` wins), newest first, at most 20. An undo marks what it undid,
 * so a live calendar.changed shows before the log is fetched again.
 */
export function mergeChanges(fresh: CalendarChange[], old: CalendarChange[]): CalendarChange[] {
  const byId = new Map<string, CalendarChange>();
  for (const c of [...old, ...fresh]) byId.set(c.id, c);
  for (const c of byId.values()) {
    const target = c.undoOf ? byId.get(c.undoOf) : undefined;
    if (target && !target.undoneAt) byId.set(target.id, { ...target, undoneAt: c.at });
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
}

// ── New event ──

export interface NewEventDraft {
  title: string;
  /** YYYY-MM-DD */
  day: string;
  /** HH:MM */
  start: string;
  minutes: number;
  /** Names, comma separated. */
  guests: string;
}

export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  const hours = `${h} ${h === 1 ? "hour" : "hours"}`;
  return m ? `${hours} ${m} min` : hours;
}

/** "Sam", "Sam and Jo", "Sam, Jo and Priya". */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** What New event asks JARVIS: “Create ‘Booking call’ Fri 16 Oct 12:00 for 30 min with Sam”. */
export function newEventText(d: NewEventDraft): string {
  const day = parseTime(d.day);
  const guests = d.guests
    .split(/,|\band\b/)
    .map((g) => g.trim())
    .filter(Boolean);
  const with_ = guests.length ? ` with ${names(guests)}` : "";
  return `Create ‘${d.title.trim()}’ ${shortDay(day)} ${d.start} for ${durationText(d.minutes)}${with_}`;
}

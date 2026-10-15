// The Today window's pure logic (JD-33): which section a window shows, how old the digest is, what's
// next on the calendar, and how times read. Times show in the Mac's own time zone.
import type { DigestEvent } from "@jarvis/shared";

/** Inbox and Slack pop out into their own section-only windows: `today?section=inbox|slack`. */
export type Section = "inbox" | "slack";

/** After this the header says the digest is stale (the worker refreshes every 30 min). */
export const STALE_AFTER_S = 45 * 60;

/** `?section=` in the web preview, `#/today?section=` in Electron. */
export function sectionFrom(location: Pick<Location, "search" | "hash">): Section | undefined {
  const hashQuery = location.hash.split("?")[1] ?? "";
  const section =
    new URLSearchParams(location.search).get("section") ?? new URLSearchParams(hashQuery).get("section");
  return section === "inbox" || section === "slack" ? section : undefined;
}

/**
 * The server's clock when the digest was fetched (generatedAt + ageSeconds), moved on by however long
 * ago that was. The calendar's "next up" uses it, so a preview of an old day still has a next event.
 */
export function digestNow(generatedAt: string, ageSeconds: number, fetchedAt: number, now: number): number {
  return Date.parse(generatedAt) + ageSeconds * 1000 + (now - fetchedAt);
}

/** The digest's age in seconds now, from its age when fetched. */
export function ageNow(ageSeconds: number, fetchedAt: number, now: number): number {
  return ageSeconds + Math.max(0, Math.round((now - fetchedAt) / 1000));
}

export const isStale = (ageSeconds: number): boolean => ageSeconds > STALE_AFTER_S;

/** "4 min", "1 h", "2 h 20 min". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The event happening now, else the next one to start; -1 when the day is over. */
export function nextUpIndex(events: DigestEvent[], now: number): number {
  return events.findIndex((e) => Date.parse(e.end) > now);
}

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "09:30" */
export const clock = (iso: string): string => timeFmt.format(new Date(iso));

/** "Wed 14 Oct" */
export const day = (iso: string | number): string => dayFmt.format(new Date(iso)).replace(",", "");

const dayKey = (t: number) => new Date(t).toDateString();

/** When a message arrived: "07:31" today, "yesterday", or "Mon 12 Oct". */
export function received(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (dayKey(t) === dayKey(now)) return clock(iso);
  if (dayKey(t) === dayKey(now - 86_400_000)) return "yesterday";
  return day(t);
}

/** The line under an event's title: "Next up · in 2 h 30 min · Dishoom", "Now · until 09:45 · Work". */
export function eventMeta(event: DigestEvent, now: number, isNextUp: boolean): string {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const where = event.location ?? event.calendar;
  if (isNextUp && start <= now) return `Now · until ${clock(event.end)} · ${where}`;
  if (isNextUp) return `Next up · in ${span(start - now)} · ${where}`;
  return `${span(end - start)} · ${where}`;
}

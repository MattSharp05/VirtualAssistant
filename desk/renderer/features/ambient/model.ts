// The ambient face's logic (JD-25), kept out of the component so it's unit-tested on its own: the
// clock and date, the next event, session counts, the last report, to-dos and the plan meters.
import type { DeskSession, DigestEvent, OrbState, TaskItem } from "@jarvis/shared";

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

/** "09:30" */
export const clockText = (t: number | string): string => timeFmt.format(new Date(t));

/** "Wednesday 14 October" */
export const dateText = (t: number): string => dateFmt.format(new Date(t)).replace(",", "");

/** "4 min", "1 h", "2 h 20 min". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function ago(at: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / (24 * 60))} d ago`;
}

export interface NextEvent {
  /** "Standup · 09:30" */
  title: string;
  /** "in 30 min", "now · until 09:45" */
  when: string;
  location?: string;
}

/** The event happening now, else the next one to start; undefined when the day is over. */
export function nextEvent(events: DigestEvent[], now: number): NextEvent | undefined {
  const e = events.find((ev) => Date.parse(ev.end) > now);
  if (!e) return undefined;
  const start = Date.parse(e.start);
  return {
    title: `${e.title} · ${clockText(e.start)}`,
    when: start <= now ? `now · until ${clockText(e.end)}` : `in ${span(start - now)}`,
    ...(e.location ? { location: e.location } : {}),
  };
}

export interface SessionCounts {
  working: number;
  /** Needs Matthew (a decision, QA) but isn't blocked. */
  waiting: number;
  blocked: number;
}

export function sessionCounts(sessions: DeskSession[]): SessionCounts {
  const counts = { working: 0, waiting: 0, blocked: 0 };
  for (const s of sessions) {
    if (s.group === "working") counts.working++;
    else if (s.group === "needs-you") counts[s.latestKind === "blocked" ? "blocked" : "waiting"]++;
  }
  return counts;
}

export interface LastReport {
  who: string;
  at: string;
  text: string;
}

/** The session that reported most recently (by its last activity), with its report's first line. */
export function lastReport(sessions: DeskSession[]): LastReport | undefined {
  let best: DeskSession | undefined;
  for (const s of sessions)
    if (s.latestReport && s.lastActivity && (!best || s.lastActivity > best.lastActivity!)) best = s;
  if (!best) return undefined;
  return { who: best.name ?? best.title, at: best.lastActivity!, text: best.latestReport!.split("\n")[0]! };
}

export const openCount = (tasks: TaskItem[]): number => tasks.filter((t) => t.status === "Open").length;

export type MeterTone = "ok" | "high" | "full";

/** Amber from 80 %, red from 95 %, like the mood. */
export const meterTone = (percent: number): MeterTone =>
  percent >= 95 ? "full" : percent >= 80 ? "high" : "ok";

/** The line under JARVIS. */
export const ORB_CAPTION: Record<OrbState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

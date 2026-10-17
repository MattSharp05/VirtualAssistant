// What a session has used (JD-54): the number formats, the context bar's colour and the list's
// metric sorts. Unknown values stay undefined all the way to the screen, where they render as "—".
import type { DeskSession } from "@jarvis/shared";

/** Shown (with UNKNOWN_HINT as its tooltip) for every value the API didn't report. */
export const UNKNOWN = "—";
export const UNKNOWN_HINT = "not reported by the API";

const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.0+$/, "");

/** "812", "6.8 k", "96 k", "1.2 M", "831 M", "1.4 B"; undefined when unknown. */
export function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  const step = (unit: number, suffix: string) => `${trim(n / unit, n / unit < 10 ? 1 : 0)} ${suffix}`;
  if (n >= 1e9) return step(1e9, "B");
  if (n >= 1e6) return step(1e6, "M");
  if (n >= 1e3) return step(1e3, "k");
  return String(n);
}

/** "$0.42", "$269.76", "$1,284"; undefined when unknown. */
export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined) return undefined;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return usd >= 1000
    ? `$${Math.round(usd).toLocaleString("en-US")}`
    : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "<1m", "47m", "9h 5m", "2d 3h" (short: "47m", "9h", "2d"); undefined when unknown. */
export function formatDuration(ms: number | undefined, short = false): string | undefined {
  if (ms === undefined) return undefined;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return short || min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  return short || h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** The context bar: amber from 70% used, red from 85%. */
export type ContextTone = "ok" | "amber" | "red";

export function contextTone(percent: number): ContextTone {
  if (percent >= 85) return "red";
  return percent >= 70 ? "amber" : "ok";
}

/** "1,204", or "612+" when the history was longer than one read (the count is a lower bound). */
export function formatCount(n: number | undefined, partial?: boolean): string | undefined {
  if (n === undefined) return undefined;
  return `${n.toLocaleString("en-US")}${partial ? "+" : ""}`;
}

/** "MarioKart #79" from a GitHub PR link. */
export function prLabel(url: string): string {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]} #${m[2]}` : url;
}

/** needs-you: the server's grouped order · cost and context: one list, biggest first. */
export type SessionSort = "needs-you" | "cost" | "context";

export const SORTS: { id: SessionSort; label: string }[] = [
  { id: "needs-you", label: "Needs you first" },
  { id: "cost", label: "Most expensive" },
  { id: "context", label: "Context fullest" },
];

const SORT_KEY: Record<Exclude<SessionSort, "needs-you">, (s: DeskSession) => number | undefined> = {
  cost: (s) => s.metrics?.costUsd,
  context: (s) => s.metrics?.contextPercent,
};

/** Biggest first; sessions that don't report the value go last, in the order they came. */
export function sortSessions(
  sessions: DeskSession[],
  sort: Exclude<SessionSort, "needs-you">,
): DeskSession[] {
  const key = SORT_KEY[sort];
  return sessions
    .map((s, i) => ({ s, i, v: key(s) }))
    .sort((a, b) => {
      if (a.v === undefined || b.v === undefined) return a.v === b.v ? a.i - b.i : a.v === undefined ? 1 : -1;
      return b.v - a.v || a.i - b.i;
    })
    .map((x) => x.s);
}

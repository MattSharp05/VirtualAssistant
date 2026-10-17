// Project totals and the 30-day history (JD-55) as pure functions: money text, the projects table's
// sort, and the stacked bars' series and geometry. Series follow the projects list's order (all-time
// cost, the server's order), so a project keeps its colour when the chart switches to tokens or the
// table is re-sorted. The five biggest get a colour each; the rest fold into "Other".
import type { ProjectUsage, ProjectUsagePeriod, UsageDay } from "@jarvis/shared";

/** "$0", "<$0.01", "$0.42", "$12.40", "$1,240". */
export function money(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

/** Axis labels: "$0", "$25", "$0.50" (cents only when the tick needs them). */
export function moneyAxis(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : money(n);
}

export type Metric = "cost" | "tokens";
export type Period = "week" | "allTime";
export type SortKey = "project" | "cost" | "tokens" | "sessions" | "active" | "wall" | "activeTime";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

const value = (p: ProjectUsage, period: Period, key: SortKey): number | string => {
  const u: ProjectUsagePeriod = p[period];
  switch (key) {
    case "project":
      return p.project.toLowerCase();
    case "cost":
      return u.costUsd;
    case "tokens":
      return u.tokens;
    case "sessions":
      return u.sessions;
    case "active":
      return p.activeSessions;
    case "wall":
      return u.wallMs;
    case "activeTime":
      return u.activeMs;
  }
};

/** The table's rows sorted by a column (ties keep the server's order). */
export function sortProjects(projects: readonly ProjectUsage[], period: Period, sort: Sort): ProjectUsage[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const x = value(a.p, period, sort.key);
      const y = value(b.p, period, sort.key);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return c * sign || a.i - b.i;
    })
    .map(({ p }) => p);
}

/** Clicking a header: the same column flips; a new one starts high-to-low (A–Z for names). */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "project" ? "asc" : "desc" };
}

/** Named colours in the chart; past these a project folds into "Other". */
export const SERIES_SLOTS = 5;
export const OTHER = "Other";

export interface Series {
  key: string;
  /** 1..SERIES_SLOTS, or "other" for the folded rest. */
  slot: number | "other";
}

/** The chart's series: the first five projects (all-time order), then "Other" if anything's left. */
export function chartSeries(projects: readonly ProjectUsage[], history: readonly UsageDay[]): Series[] {
  const names = projects.map((p) => p.project);
  // Projects only in the history (the table is all time, so this is rare) go after the rest.
  for (const d of history) for (const k of Object.keys(d.projects)) if (!names.includes(k)) names.push(k);
  const named = names.filter((n) => n !== OTHER).slice(0, SERIES_SLOTS);
  const series: Series[] = named.map((key, i) => ({ key, slot: i + 1 }));
  if (names.some((n) => !named.includes(n))) series.push({ key: OTHER, slot: "other" });
  return series;
}

export interface Segment {
  key: string;
  value: number;
}

export interface BarDay {
  day: string;
  total: number;
  /** In series order, only the series with something that day. */
  segments: Segment[];
}

/** Each day's stack for the metric, with folded projects summed into "Other". */
export function stackDays(history: readonly UsageDay[], series: readonly Series[], metric: Metric): BarDay[] {
  const keys = new Set(series.map((s) => s.key));
  return history.map((d) => {
    const sums = new Map<string, number>();
    for (const [project, u] of Object.entries(d.projects)) {
      const key = keys.has(project) && project !== OTHER ? project : OTHER;
      sums.set(key, (sums.get(key) ?? 0) + (metric === "cost" ? u.costUsd : u.tokens));
    }
    const segments = series.flatMap((s) => {
      const v = sums.get(s.key) ?? 0;
      return v > 0 ? [{ key: s.key, value: v }] : [];
    });
    return { day: d.day, total: metric === "cost" ? d.costUsd : d.tokens, segments };
  });
}

/** A round top for the y axis (1, 2 or 5 × 10ⁿ, at least the max) and its gridlines (0, half, top). */
export function niceScale(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 0.5, 1] };
  const pow = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map((m) => m * pow).find((t) => t >= max) ?? 10 * pow;
  return { top, ticks: [0, top / 2, top] };
}

/** "14 Oct" for "2026-10-14" (the server's calendar day, so no time zone applies). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "Tue 14 Oct". */
export function dayLong(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

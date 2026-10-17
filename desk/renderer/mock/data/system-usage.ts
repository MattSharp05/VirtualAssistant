// Cloud session use per project and per day (JD-55) for the System window: 30 days ending on the demo
// day (14 Oct), from the same projects the Sessions window shows. Totals add up: each project's week
// is the sum of its last 7 days, and all time is the 30 days plus what came before. data/system.ts
// puts these on GET /system.
import type { ProjectUsage, UsageDay } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const DAYS = 30;
const LAST_DAY = Date.UTC(2026, 9, 14);
const H = 3_600_000;

export interface MockProject {
  project: string;
  /** Dollars on day i (0 = 30 days ago, 29 = the demo day). */
  cost: (i: number) => number;
  /** Tokens per dollar (mostly cache reads, as in the live sessions). */
  tokensPerUsd: number;
  activeSessions: number;
  /** Before the 30 days. */
  earlier: { costUsd: number; sessions: number; wallMs: number; activeMs: number };
  /** Sessions in the last 7 days and their times there. */
  week: { sessions: number; wallMs: number; activeMs: number };
  /** Sessions in the 30 days (all time adds `earlier.sessions`). */
  sessions: number;
}

/** A smooth, deterministic wobble (no randomness, so snapshots stay put). */
const wave = (i: number, period: number, phase = 0) => (Math.sin((i + phase) / period) + 1) / 2;
const cents = (n: number) => Math.round(n * 100) / 100;

export const demoProjects: MockProject[] = [
  {
    project: "mario-kart",
    // Busy for the last two weeks of builder waves, quiet on Sundays.
    cost: (i) => (i < 12 ? 0 : i % 7 === 4 ? 1.2 : 9 + 14 * wave(i, 2.3)),
    tokensPerUsd: 3_100_000,
    activeSessions: 2,
    earlier: { costUsd: 61.4, sessions: 4, wallMs: 52 * H, activeMs: 11 * H },
    week: { sessions: 5, wallMs: 96 * H, activeMs: 22 * H },
    sessions: 9,
  },
  {
    project: "jarvis",
    cost: (i) => 4 + 9 * wave(i, 3.1, 2),
    tokensPerUsd: 2_900_000,
    activeSessions: 1,
    earlier: { costUsd: 212.6, sessions: 6, wallMs: 140 * H, activeMs: 31 * H },
    week: { sessions: 3, wallMs: 118 * H, activeMs: 16 * H },
    sessions: 7,
  },
  {
    project: "trip-planner",
    cost: (i) => (i >= 22 ? 2.5 + 4 * wave(i, 1.7) : 0),
    tokensPerUsd: 2_400_000,
    activeSessions: 1,
    earlier: { costUsd: 0, sessions: 0, wallMs: 0, activeMs: 0 },
    week: { sessions: 2, wallMs: 41 * H, activeMs: 6 * H },
    sessions: 2,
  },
  {
    project: "shapemint",
    cost: (i) => (i < 18 && i % 3 !== 2 ? 1.5 + 3 * wave(i, 2, 1) : 0),
    tokensPerUsd: 2_600_000,
    activeSessions: 0,
    earlier: { costUsd: 34.8, sessions: 3, wallMs: 30 * H, activeMs: 7 * H },
    week: { sessions: 0, wallMs: 0, activeMs: 0 },
    sessions: 3,
  },
  {
    project: "Other",
    cost: (i) => (i % 5 === 1 ? 0.9 : 0),
    tokensPerUsd: 1_800_000,
    activeSessions: 0,
    earlier: { costUsd: 6.2, sessions: 2, wallMs: 3 * H, activeMs: 1 * H },
    week: { sessions: 1, wallMs: 2 * H, activeMs: 0.5 * H },
    sessions: 4,
  },
];

const dayOf = (i: number) => new Date(LAST_DAY - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);

/** The 30 days, oldest first, and each project's totals, from the projects' daily costs. */
export function usageFor(projects: readonly MockProject[]): {
  projects: ProjectUsage[];
  history: UsageDay[];
} {
  const history: UsageDay[] = Array.from({ length: DAYS }, (_, i) => {
    const entries = projects.flatMap((p) => {
      const c = cents(p.cost(i));
      return c > 0 ? [[p.project, { costUsd: c, tokens: Math.round(c * p.tokensPerUsd) }] as const] : [];
    });
    return {
      day: dayOf(i),
      costUsd: cents(entries.reduce((n, [, u]) => n + u.costUsd, 0)),
      tokens: entries.reduce((n, [, u]) => n + u.tokens, 0),
      projects: Object.fromEntries(entries),
    };
  });
  const sum = (name: string, from: number, key: "costUsd" | "tokens") =>
    history.slice(from).reduce((n, d) => n + (d.projects[name]?.[key] ?? 0), 0);
  const totals: ProjectUsage[] = projects.map((p) => {
    const thirty = sum(p.project, 0, "costUsd");
    const weekCost = sum(p.project, DAYS - 7, "costUsd");
    // Nothing spent in the week means no sessions or time there either.
    const week = weekCost > 0 ? p.week : { sessions: 0, wallMs: 0, activeMs: 0 };
    return {
      project: p.project,
      activeSessions: p.activeSessions,
      week: {
        costUsd: cents(weekCost),
        tokens: sum(p.project, DAYS - 7, "tokens"),
        ...week,
      },
      allTime: {
        costUsd: cents(thirty + p.earlier.costUsd),
        tokens: sum(p.project, 0, "tokens") + Math.round(p.earlier.costUsd * p.tokensPerUsd),
        sessions: p.sessions + p.earlier.sessions,
        wallMs: p.week.wallMs * 2 + p.earlier.wallMs,
        activeMs: p.week.activeMs * 2 + p.earlier.activeMs,
      },
    };
  });
  totals.sort((a, b) => b.allTime.costUsd - a.allTime.costUsd);
  return { projects: totals, history };
}

export const demoUsage = usageFor(demoProjects);

// data/system.ts serves these on "/system"; this file has no paths of its own.
const part: ScenarioPart = {};
export default part;

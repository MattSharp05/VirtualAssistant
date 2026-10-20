// Project totals and history (JD-55): what the cloud sessions used, per project and per day.
//
// Once an hour (and at startup) index.ts records each session's cumulative cost, tokens, active and
// wall time (sessionMetrics.ts) in <dataDir>/session-usage.jsonl, one line per session whose numbers
// changed. A day's use is the increase over that day's snapshots, so a long session counts on the
// days it actually worked. What a session had used before its first snapshot (it predates this
// log) goes on the day of its last activity then. Snapshots are kept 90 days, plus each session's
// newest older one as the baseline its later increases are measured from.
//
// A session's project is its `project:<name>` tag (the workflow plugin sets it), else the name of
// the repository it runs on, else "Other". Days are in the server's time zone (TZ).

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectUsage, ProjectUsagePeriod, SessionMetrics, UsageDay } from "@jarvis/shared";
import type { Jarvis } from "./jarvis.js";

export const SNAPSHOT_MS = 60 * 60_000;
export const RETENTION_DAYS = 90;
export const HISTORY_DAYS = 30;
export const WEEK_DAYS = 7;
/** Detail reads at once while snapshotting. */
const CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60_000;

/** One session's cumulative numbers at one hour. Unknown values are absent, never 0. */
export interface UsageSnapshot {
  at: string;
  sessionId: string;
  project: string;
  costUsd?: number;
  tokens?: number;
  activeMs?: number;
  wallMs?: number;
  createdAt?: string;
  updatedAt?: string;
  /** The session was working (its status bucket) when the snapshot was taken. */
  working?: boolean;
}

export type SnapshotRow = Omit<UsageSnapshot, "at">;

export const OTHER = "Other";

/** `project:<name>` tag, else the repository's name ("owner/name" → "name"), else undefined. */
export function projectName(m: Pick<SessionMetrics, "tags" | "repo">): string | undefined {
  const tag = m.tags?.find((t) => /^project:\s*\S/i.test(t));
  if (tag) return tag.slice("project:".length).trim();
  return m.repo?.split("/").pop()?.trim() || undefined;
}

/** projectName, else "Other". */
export function projectOf(m: Pick<SessionMetrics, "tags" | "repo">): string {
  return projectName(m) ?? OTHER;
}

/** A snapshot row from a session's metrics (undefined when nothing about its use is known). */
export function rowFor(sessionId: string, m: SessionMetrics): SnapshotRow | undefined {
  if (m.costUsd === undefined && m.totalTokens === undefined) return undefined;
  const row: SnapshotRow = {
    sessionId,
    project: projectOf(m),
    costUsd: m.costUsd,
    tokens: m.totalTokens,
    activeMs: m.activeMs,
    wallMs: m.wallMs,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    working: m.statusBucket === "working",
  };
  for (const k of Object.keys(row) as (keyof SnapshotRow)[]) if (row[k] === undefined) delete row[k];
  return row;
}

/** "2026-10-17" in the server's time zone. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last `n` day keys, oldest first, ending with today. */
export function lastDays(now: number, n: number): string[] {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(d);
    day.setDate(d.getDate() - (n - 1 - i));
    return dayKey(day.getTime());
  });
}

/** Midnight at the start of the day `n - 1` days before today (the first of the last `n` days). */
function startOfDays(now: number, n: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (n - 1));
  return d.getTime();
}

export interface Increase {
  sessionId: string;
  day: string;
  costUsd: number;
  tokens: number;
  activeMs: number;
}

const grouped = (snapshots: readonly UsageSnapshot[]) => {
  const by = new Map<string, UsageSnapshot[]>();
  for (const s of snapshots) by.set(s.sessionId, [...(by.get(s.sessionId) ?? []), s]);
  for (const list of by.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return by;
};

/**
 * Each session's increases between snapshots, on the day of the later one. The first snapshot's
 * numbers (use from before the log) go on the day of the session's last activity at that point.
 */
export function increases(snapshots: readonly UsageSnapshot[]): Increase[] {
  const out: Increase[] = [];
  for (const [sessionId, list] of grouped(snapshots)) {
    let prev = { costUsd: 0, tokens: 0, activeMs: 0 };
    list.forEach((s, i) => {
      const at = Date.parse(s.at);
      const updated = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
      const when = i === 0 && updated <= at ? updated : at;
      const next = { costUsd: s.costUsd ?? prev.costUsd, tokens: s.tokens ?? prev.tokens, activeMs: s.activeMs ?? prev.activeMs };
      const inc = {
        costUsd: Math.max(0, next.costUsd - prev.costUsd),
        tokens: Math.max(0, next.tokens - prev.tokens),
        activeMs: Math.max(0, next.activeMs - prev.activeMs),
      };
      if (inc.costUsd || inc.tokens || inc.activeMs) out.push({ sessionId, day: dayKey(when), ...inc });
      prev = next;
    });
  }
  return out;
}

const emptyPeriod = (): ProjectUsagePeriod => ({ costUsd: 0, tokens: 0, sessions: 0, wallMs: 0, activeMs: 0 });
/** Cents and whole tokens/ms, so sums of floats don't show as 12.340000000001. */
const round = (p: ProjectUsagePeriod): ProjectUsagePeriod => ({
  ...p,
  costUsd: Math.round(p.costUsd * 100) / 100,
  tokens: Math.round(p.tokens),
  wallMs: Math.round(p.wallMs),
  activeMs: Math.round(p.activeMs),
});

export interface UsageSummary {
  projects: ProjectUsage[];
  history: UsageDay[];
}

/** Per-project totals (this week and all time) and the last 30 days, from the snapshots. */
export function summarize(snapshots: readonly UsageSnapshot[], now = Date.now()): UsageSummary {
  const sessions = grouped(snapshots);
  // A session's latest snapshot names its project for all its days (a tag added later moves it all).
  const latest = new Map([...sessions].map(([id, list]) => [id, list[list.length - 1]]));
  const projectFor = (id: string) => latest.get(id)!.project;
  const incs = increases(snapshots);

  const days = lastDays(now, HISTORY_DAYS);
  const byDay = new Map<string, UsageDay>(days.map((day) => [day, { day, costUsd: 0, tokens: 0, projects: {} }]));
  for (const inc of incs) {
    const d = byDay.get(inc.day);
    if (!d) continue;
    const project = projectFor(inc.sessionId);
    d.costUsd += inc.costUsd;
    d.tokens += inc.tokens;
    const p = (d.projects[project] ??= { costUsd: 0, tokens: 0 });
    p.costUsd += inc.costUsd;
    p.tokens += inc.tokens;
  }
  const cents = (n: number) => Math.round(n * 100) / 100;
  const history = days.map((day) => {
    const d = byDay.get(day)!;
    const projects = Object.fromEntries(Object.entries(d.projects).map(([k, v]) => [k, { costUsd: cents(v.costUsd), tokens: Math.round(v.tokens) }]));
    return { day, costUsd: cents(d.costUsd), tokens: Math.round(d.tokens), projects };
  });

  const out = new Map<string, ProjectUsage>();
  const project = (name: string) => {
    let p = out.get(name);
    if (!p) out.set(name, (p = { project: name, activeSessions: 0, week: emptyPeriod(), allTime: emptyPeriod() }));
    return p;
  };
  for (const s of latest.values()) {
    const p = project(s.project);
    p.allTime.costUsd += s.costUsd ?? 0;
    p.allTime.tokens += s.tokens ?? 0;
    p.allTime.activeMs += s.activeMs ?? 0;
    p.allTime.wallMs += s.wallMs ?? 0;
    p.allTime.sessions++;
    if (s.working) p.activeSessions++;
  }
  const week = new Set(lastDays(now, WEEK_DAYS));
  const weekStart = startOfDays(now, WEEK_DAYS);
  const inWeek = new Set<string>();
  for (const inc of incs) {
    if (!week.has(inc.day)) continue;
    const w = project(projectFor(inc.sessionId)).week;
    w.costUsd += inc.costUsd;
    w.tokens += inc.tokens;
    w.activeMs += inc.activeMs;
    inWeek.add(inc.sessionId);
  }
  for (const id of inWeek) {
    const s = latest.get(id)!;
    const w = project(s.project).week;
    w.sessions++;
    // Wall time inside the week: its span (created → created + wall time) clipped to the week.
    if (s.createdAt && s.wallMs !== undefined) {
      const start = Date.parse(s.createdAt);
      w.wallMs += Math.max(0, Math.min(now, start + s.wallMs) - Math.max(start, weekStart));
    }
  }
  const projects = [...out.values()]
    .map((p) => ({ ...p, week: round(p.week), allTime: round(p.allTime) }))
    .sort((a, b) => b.allTime.costUsd - a.allTime.costUsd || b.allTime.tokens - a.allTime.tokens || a.project.localeCompare(b.project));
  return { projects, history };
}

const same = (a: UsageSnapshot, b: SnapshotRow) =>
  a.project === b.project && a.costUsd === b.costUsd && a.tokens === b.tokens && a.activeMs === b.activeMs && Boolean(a.working) === Boolean(b.working);

/** Parsed files by path, reused while the file's size and mtime don't change (GET /system polls). */
const cache = new Map<string, { key: string; list: UsageSnapshot[] }>();

/** The snapshots on disk, oldest first. */
export class SessionUsageLog {
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dataDir, "session-usage.jsonl");
  }

  list(): UsageSnapshot[] {
    if (!existsSync(this.file)) return [];
    const st = statSync(this.file);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(this.file);
    if (hit?.key === key) return hit.list;
    const list = readFileSync(this.file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const s = line.trim() ? (JSON.parse(line) as UsageSnapshot) : undefined;
          return s && typeof s.sessionId === "string" && typeof s.at === "string" ? [s] : [];
        } catch {
          return [];
        }
      });
    cache.set(this.file, { key, list });
    return list;
  }

  /** Appends the rows whose numbers changed since the session's last snapshot; returns how many. */
  record(rows: readonly SnapshotRow[]): number {
    const all = this.list();
    const last = new Map<string, UsageSnapshot>();
    for (const s of all) last.set(s.sessionId, s);
    const at = new Date(this.now()).toISOString();
    const fresh = rows.filter((r) => {
      const prev = last.get(r.sessionId);
      return !prev || !same(prev, r);
    });
    if (fresh.length) appendFileSync(this.file, fresh.map((r) => `${JSON.stringify({ at, ...r })}\n`).join(""));
    this.prune();
    return fresh.length;
  }

  /** Drops snapshots older than 90 days, except each session's newest one of those (its baseline). */
  prune(): void {
    const all = this.list();
    const cutoff = new Date(this.now() - RETENTION_DAYS * DAY_MS).toISOString();
    const baseline = new Map<string, UsageSnapshot>();
    for (const s of all) if (s.at < cutoff) baseline.set(s.sessionId, s);
    const keep = all.filter((s) => s.at >= cutoff || baseline.get(s.sessionId) === s);
    if (keep.length < all.length) writeFileSync(this.file, keep.map((s) => `${JSON.stringify(s)}\n`).join(""));
  }

  summary(): UsageSummary {
    return summarize(this.list(), this.now());
  }
}

/** Every session JARVIS can see (the cloud list and the tracked jobs), with its metrics now. */
export async function snapshotRows(jarvis: Pick<Jarvis, "listSessions" | "store" | "metrics">): Promise<SnapshotRow[]> {
  const cloud = await jarvis.listSessions();
  const ids = [...new Set([...(cloud.available ? cloud.sessions.map((s) => s.id) : []), ...jarvis.store.recentJobs(1000).map((j) => j.sessionId)])];
  const rows: SnapshotRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const m = await jarvis.metrics.full(id).catch(() => undefined);
      const row = m && rowFor(id, m);
      if (row) rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return rows;
}

/** One snapshot of every session into the log (index.ts runs it at startup and every hour). */
export async function recordSessionUsage(jarvis: Pick<Jarvis, "listSessions" | "store" | "metrics">, log: SessionUsageLog): Promise<number> {
  return log.record(await snapshotRows(jarvis));
}

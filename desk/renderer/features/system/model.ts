// The System window's numbers (JD-30): meter levels and the text the dashboard's tiles show, as pure
// functions. Relative times are measured from the response's checkedAt (the server's clock), so they
// don't depend on the Mac's clock or the preview's.
import type { BrainUsageToday } from "@jarvis/shared";

/** ok below 75%, amber from 75%, red from 90% (the dashboard's "Getting close" / "Nearly out"). */
export type MeterLevel = "ok" | "amber" | "red";

export const AMBER_AT = 75;
export const RED_AT = 90;

export function meterLevel(percent: number): MeterLevel {
  if (percent >= RED_AT) return "red";
  if (percent >= AMBER_AT) return "amber";
  return "ok";
}

/** 0..100, or null when there's nothing to divide by. */
export function percentOf(used: number | null, limit: number | null): number | null {
  if (used === null || !limit) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

const MB = 2 ** 20;
const GB = 2 ** 30;

/** "412 MB", "1.5 GB"; "—" when unknown. */
export function bytes(n: number | null): string {
  if (n === null) return "—";
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / MB)} MB`;
}

/** "980", "12.4k", "184k", "2.3M". */
export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** "45 s", "12 min", "2 h 10 min", "3 d 4 h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "in 2 h 10 min" from `now`; "now" once it has passed. */
export function inFrom(at: string | undefined, now: string): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at) - Date.parse(now);
  if (Number.isNaN(ms)) return undefined;
  return ms <= 0 ? "now" : `in ${duration(ms)}`;
}

/** "just now", "4 min ago", "3 h ago". */
export function agoFrom(at: string | undefined, now: string): string {
  if (!at) return "never";
  const ms = Date.parse(now) - Date.parse(at);
  if (Number.isNaN(ms)) return "never";
  return ms < 60_000 ? "just now" : `${duration(ms)} ago`;
}

/** The worker's share of today's tokens, 0..100 (0 when neither has used any). */
export function workerShare(chat: BrainUsageToday, worker: BrainUsageToday): number {
  const total = chat.tokens + worker.tokens;
  return total ? (worker.tokens / total) * 100 : 0;
}

export interface Spark {
  /** The SVG polyline's points in a `width`×`height` box. */
  points: string;
  min: number;
  max: number;
}

/**
 * A sparkline over the known values (nulls are skipped), scaled to their own min..max so small
 * changes show. Undefined with fewer than two values.
 */
export function sparkline(values: (number | null)[], width: number, height: number): Spark | undefined {
  const known = values.flatMap((v, i) => (v === null ? [] : [{ v, i }]));
  if (known.length < 2) return undefined;
  const min = Math.min(...known.map((k) => k.v));
  const max = Math.max(...known.map((k) => k.v));
  const span = max - min || 1;
  const last = values.length - 1 || 1;
  const pad = 2;
  const points = known
    .map(({ v, i }) => {
      const x = (i / last) * width;
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return { points, min, max };
}

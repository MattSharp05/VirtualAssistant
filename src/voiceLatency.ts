// Voice latency (JD-48): the Desk reports every voice turn's stage timings (ms after Matthew's last
// word: endpoint, transcript, sent, accepted, first delta, first sentence, say ready, first audio) to
// POST /api/desk/system/latency. They're kept in <dataDir>/voice-latency.jsonl (trimmed to the last
// 200) and summarised for the System window: p50/p90 of the first word over the last 20 turns that
// got one, and each stage's median, so the biggest contributor is plain to see. The PRD's target is
// p50 ≤ 2.5 s and p90 ≤ 3.5 s for a simple question on a warm session.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceLatencyStage, VoiceLatencyStages, VoiceLatencySummary, VoiceLatencyTurn } from "@jarvis/shared";

/** Pipeline order: what the summary lists and the System window draws. */
export const LATENCY_STAGES: readonly VoiceLatencyStage[] = ["endpoint", "transcript", "sent", "accepted", "firstDelta", "firstSentence", "sayReady", "audioStart"];
export const SUMMARY_TURNS = 20;
const KEEP = 200;
/** A stage later than this (ms) is a broken clock, not a slow turn. */
const MAX_MS = 10 * 60_000;

/** The p-th percentile (0..100) by nearest rank; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/** p50/p90 of the first word over the last `n` turns that reached it, and each stage's median. */
export function summarizeLatency(turns: readonly VoiceLatencyTurn[], n = SUMMARY_TURNS): VoiceLatencySummary {
  const recent = turns.filter((t) => t.stages.audioStart !== undefined).slice(-n);
  const firstWords = recent.map((t) => t.stages.audioStart!);
  const stages = LATENCY_STAGES.flatMap((stage) => {
    const p50 = percentile(recent.flatMap((t) => (t.stages[stage] === undefined ? [] : [t.stages[stage]!])), 50);
    return p50 === null ? [] : [{ stage, p50 }];
  });
  const last = turns.at(-1);
  return { turns: recent.length, p50: percentile(firstWords, 50), p90: percentile(firstWords, 90), stages, ...(last ? { last } : {}) };
}

/** A reported turn checked and tidied (whole ms, known stages only); throws a readable Error. */
export function parseLatencyTurn(body: Record<string, unknown>): VoiceLatencyTurn {
  const at = typeof body.at === "string" ? body.at : "";
  if (Number.isNaN(Date.parse(at))) throw new Error("at must be an ISO date-time");
  const trigger = body.trigger === "wake" ? "wake" : body.trigger === "ptt" ? "ptt" : undefined;
  if (!trigger) throw new Error("trigger is ptt or wake");
  const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= -MAX_MS && v <= MAX_MS ? Math.round(v) : undefined);
  const raw = typeof body.stages === "object" && body.stages !== null ? (body.stages as Record<string, unknown>) : {};
  const stages: VoiceLatencyStages = {};
  for (const stage of LATENCY_STAGES) {
    const v = ms(raw[stage]);
    if (v !== undefined) stages[stage] = v;
  }
  const model = typeof body.model === "string" && body.model.length <= 100 ? body.model : undefined;
  return { at, trigger, speechMs: Math.max(0, ms(body.speechMs) ?? 0), ...(model ? { model } : {}), stages };
}

/** The turns on disk, oldest first. */
export class VoiceLatencyLog {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "voice-latency.jsonl");
  }

  list(): VoiceLatencyTurn[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line) as VoiceLatencyTurn] : [];
        } catch {
          return [];
        }
      });
  }

  add(turn: VoiceLatencyTurn): void {
    appendFileSync(this.file, `${JSON.stringify(turn)}\n`);
    const all = this.list();
    if (all.length > KEEP * 1.5) writeFileSync(this.file, all.slice(-KEEP).map((t) => `${JSON.stringify(t)}\n`).join(""));
  }

  summary(): VoiceLatencySummary {
    return summarizeLatency(this.list());
  }
}

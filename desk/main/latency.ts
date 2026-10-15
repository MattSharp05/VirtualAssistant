// Voice latency (JD-48): how long from Matthew's last word to JARVIS's first, stage by stage. The
// PRD's target is the first spoken word ≤ 2.5 s after he stops talking (p50; p90 ≤ 3.5 s). One
// LatencyTracker follows the voice turn in flight:
//   push-to-talk (controller.ts) → start · heard (speech end, the endpointer's wait, Whisper done) ·
//     sent · accepted (the messageId)
//   the server's events → the reply's first brain.delta (and its end)
//   the Speaker (speaker.ts) → first sentence complete · `say` file ready · afplay started
// A turn is recorded at its first word, or once its reply ended without one (spoken replies off,
// nothing to say: after SPEECH_WAIT_MS), or when the next turn starts or it's cancelled after being
// sent. Stages are ms after the end of speech; main/index.ts appends each turn to
// userData/voice-latency.jsonl and reports it to the server (POST /system/latency), which summarises
// the last 20 for the System window. Pure: the clock and timers are injected.
import type { DeskEvent, VoiceLatencyStage, VoiceLatencyTurn } from "@jarvis/shared";

/** How long after the reply's end its first word may still come (the last `say` of a short reply). */
export const SPEECH_WAIT_MS = 15_000;

/** What push-to-talk tells the tracker about its turn. */
export interface TurnTiming {
  start(trigger: VoiceLatencyTurn["trigger"]): void;
  /** Speech ended at `speechEndAt` (ms, the tracker's clock), detected `endpointMs` later; transcribed now. */
  heard(heard: { speechEndAt: number; endpointMs: number; speechMs: number }): void;
  sent(): void;
  accepted(messageId: string): void;
  /** Cancelled, nothing heard, or the request failed. */
  cancel(): void;
}

/** What the Speaker tells it, for any reply it speaks. */
export type SpeechStage = "firstSentence" | "sayReady" | "audioStart";

export interface LatencyDeps {
  record(turn: VoiceLatencyTurn): void;
  /** Settings → voiceModel ("" = the chat's model). */
  model?: () => string;
  /** Wall clock in ms (Date.now). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Pending {
  trigger: VoiceLatencyTurn["trigger"];
  speechEndAt?: number;
  speechMs: number;
  model?: string;
  /** Absolute times (ms) of each stage reached. */
  marks: Partial<Record<VoiceLatencyStage, number>>;
  /** The reply's messageId, and any other desk-voice reply that started after it was sent (a morning brief). */
  replies: Set<string>;
  timer?: unknown;
}

export class LatencyTracker implements TurnTiming {
  private turn?: Pending;

  constructor(private readonly deps: LatencyDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  start(trigger: VoiceLatencyTurn["trigger"]): void {
    this.close();
    this.turn = { trigger, speechMs: 0, marks: {}, replies: new Set() };
  }

  heard({
    speechEndAt,
    endpointMs,
    speechMs,
  }: {
    speechEndAt: number;
    endpointMs: number;
    speechMs: number;
  }): void {
    const t = this.turn;
    if (!t) return;
    t.speechEndAt = speechEndAt;
    t.speechMs = speechMs;
    t.marks.endpoint = speechEndAt + endpointMs;
    t.marks.transcript = this.now();
  }

  sent(): void {
    if (!this.turn) return;
    this.turn.marks.sent = this.now();
    const model = this.deps.model?.();
    if (model) this.turn.model = model;
  }

  accepted(messageId: string): void {
    if (!this.turn) return;
    this.turn.marks.accepted = this.now();
    this.turn.replies.add(messageId);
  }

  cancel(): void {
    this.close();
  }

  /** The server's events: the reply's start, first delta and end. */
  onEvent(e: DeskEvent): void {
    const t = this.turn;
    if (!t?.marks.sent) return;
    if (e.type === "brain.start") {
      if (e.channel === "desk-voice") t.replies.add(e.messageId);
    } else if (e.type === "brain.delta") {
      if (t.replies.has(e.messageId)) t.marks.firstDelta ??= this.now();
    } else if (e.type === "brain.done" || e.type === "brain.error") {
      if (!t.replies.has(e.messageId) || t.marks.audioStart !== undefined) return;
      // Spoken replies: the first word may still be on its way (say is writing it).
      if (t.timer === undefined) {
        const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        t.timer = set(() => this.turn === t && this.close(), SPEECH_WAIT_MS);
      }
    }
  }

  /** The Speaker reached a stage for reply `messageId`. */
  speech(stage: SpeechStage, messageId: string): void {
    const t = this.turn;
    if (!t?.marks.sent || !t.replies.has(messageId)) return;
    t.marks[stage] ??= this.now();
    if (stage === "audioStart") this.close();
  }

  /** Records the turn in flight (if it got as far as asking) and forgets it. */
  private close(): void {
    const t = this.turn;
    this.turn = undefined;
    if (!t) return;
    if (t.timer !== undefined)
      (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(t.timer);
    if (t.speechEndAt === undefined || t.marks.sent === undefined) return;
    this.deps.record(toTurn(t, t.speechEndAt));
  }
}

function toTurn(t: Pending, speechEndAt: number): VoiceLatencyTurn {
  const stages: VoiceLatencyTurn["stages"] = {};
  for (const [stage, at] of Object.entries(t.marks) as [VoiceLatencyStage, number][])
    stages[stage] = Math.round(at - speechEndAt);
  return {
    at: new Date(speechEndAt).toISOString(),
    trigger: t.trigger,
    speechMs: Math.round(t.speechMs),
    ...(t.model ? { model: t.model } : {}),
    stages,
  };
}

/** One line of voice-latency.jsonl. */
export const latencyLine = (turn: VoiceLatencyTurn): string => `${JSON.stringify(turn)}\n`;

/** "voice latency: first word 2.31 s (endpoint 0.70 · transcript 1.08 · … )" for the main log. */
export function describeTurn(turn: VoiceLatencyTurn): string {
  const s = (ms: number) => (ms / 1000).toFixed(2);
  const parts = Object.entries(turn.stages).map(([k, v]) => `${k} ${s(v)}`);
  const first = turn.stages.audioStart;
  return `voice latency: ${first === undefined ? "no first word" : `first word ${s(first)} s`} (${parts.join(" · ")})`;
}

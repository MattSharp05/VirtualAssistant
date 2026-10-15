// @vitest-environment node
// A synthetic latency benchmark (JD-48): the real voice pipeline (VoiceSession → PushToTalk → server
// events → Speaker) wired like voice/index.ts, on fake timers, with every slow part faked at a known
// cost: the mic plays a recording in real time (32 ms frames), Whisper takes 350 ms, the server
// answers the request in 40 ms and streams its first words 900 ms after it, `say` takes 250 ms. The
// LatencyTracker must add those up exactly, and the tuning knobs must move the first word as expected.
import type { DeskEvent, VoiceLatencyTurn } from "@jarvis/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mic } from "../audio/recorder";
import { LatencyTracker } from "../latency";
import { PushToTalk } from "./controller";
import { record, type Segment } from "./fixtures";
import { VoiceSession } from "./session";
import { Speaker, type SpeechProcess } from "./speaker";

/** What each slow part costs, in ms. */
interface Costs {
  whisper: number;
  accept: number;
  /** From the request going out to the reply's first delta (the brain's time to first token). */
  firstDelta: number;
  say: number;
  endpointSilenceMs?: number;
}

const BASE: Costs = { whisper: 350, accept: 40, firstDelta: 900, say: 250 };
const QUESTION: Segment[] = [
  ["silence", 300],
  ["speech", 1400],
  ["silence", 2000],
];
const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

/** One spoken question through the whole pipeline; the turn the tracker recorded. */
async function oneTurn(costs: Costs): Promise<VoiceLatencyTurn> {
  const { frames, probabilities } = record(QUESTION);
  const prob = new Map(frames.map((f, i) => [f, probabilities[i]!]));
  const turns: VoiceLatencyTurn[] = [];
  const latency = new LatencyTracker({ record: (t) => void turns.push(t) });
  const events = (e: DeskEvent) => {
    latency.onEvent(e);
    speaker.onEvent(e);
    ptt.onEvent(e);
  };
  const process = (ms: number): SpeechProcess => ({ done: later(ms, undefined), stop: () => {} });
  const speaker = new Speaker({
    synthesize: () => process(costs.say),
    play: () => process(1500),
    envelope: async () => [],
    remove: () => {},
    file: (n) => `/tmp/${n}.aiff`,
    speakReplies: () => true,
    publish: () => {},
    onMark: (stage, id) => latency.speech(stage, id),
    now: () => Date.now(),
  });
  const session = new VoiceSession({
    prepare: async () => ({
      vad: { probability: async (f) => prob.get(f) ?? 0, reset: () => {} },
      transcribe: () => later(costs.whisper, "what's on today"),
    }),
    openMic: async (): Promise<Mic> => {
      let i = 0;
      return { read: () => later(32, frames[i++]!), stop: () => {} };
    },
    publish: () => {},
    endpointer: () => (costs.endpointSilenceMs ? { silenceMs: costs.endpointSilenceMs } : {}),
  });
  // The server: answers the request, then streams the reply as the brain writes it.
  const chat = async (text: string) => {
    const sent = Date.now();
    const at = (ms: number, e: DeskEvent) => setTimeout(() => events(e), sent + ms - Date.now());
    at(10, { type: "brain.start", messageId: "m1", channel: "desk-voice", text });
    at(costs.firstDelta, { type: "brain.delta", messageId: "m1", text: "You have two" });
    at(costs.firstDelta + 50, { type: "brain.delta", messageId: "m1", text: " meetings today. The first" });
    at(costs.firstDelta + 200, { type: "brain.delta", messageId: "m1", text: " is at ten." });
    at(costs.firstDelta + 210, { type: "brain.done", messageId: "m1", text: "", metrics: {} as never });
    return later(costs.accept, { messageId: "m1" });
  };
  const ptt = new PushToTalk({
    listen: (o) => session.listen(o),
    stop: () => session.stop(),
    cancel: () => session.cancel(),
    chat,
    publish: () => {},
    hint: () => "⌥⌥",
    speech: speaker,
    timing: latency,
  });
  ptt.signal("toggle");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(turns).toHaveLength(1);
  return turns[0]!;
}

describe("voice latency, end to end on fakes", () => {
  beforeEach(() => void vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") }));
  afterEach(() => void vi.useRealTimers());

  it("adds up every stage from the end of speech to the first word", async () => {
    const turn = await oneTurn(BASE);
    // The endpointer waits 704 ms (22 frames ≥ 700 ms) of silence; then Whisper, the request, the
    // brain's first words, the first sentence complete 50 ms later, and `say` writing it.
    expect(turn.stages).toEqual({
      endpoint: 704,
      transcript: 704 + 350,
      sent: 704 + 350,
      accepted: 704 + 350 + 40,
      firstDelta: 704 + 350 + 900,
      firstSentence: 704 + 350 + 950,
      sayReady: 704 + 350 + 950 + 250,
      audioStart: 704 + 350 + 950 + 250,
    });
    expect(turn.trigger).toBe("ptt");
    expect(turn.speechMs).toBeGreaterThanOrEqual(1400);
    expect(turn.stages.audioStart).toBeLessThanOrEqual(2500); // the PRD's target, on these costs
  });

  it("a shorter endpoint wait or a quicker brain moves the first word by exactly that much", async () => {
    const base = (await oneTurn(BASE)).stages.audioStart!;
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    const shorter = (await oneTurn({ ...BASE, endpointSilenceMs: 500 })).stages.audioStart!;
    expect(base - shorter).toBe(704 - 512);
    const haiku = (await oneTurn({ ...BASE, firstDelta: 500 })).stages.audioStart!;
    expect(base - haiku).toBe(400);
  });

  it("a slow brain (2 s to its first words) misses the target, and the stages say where", async () => {
    const turn = await oneTurn({ ...BASE, firstDelta: 2000 });
    expect(turn.stages.audioStart).toBeGreaterThan(2500);
    const s = turn.stages;
    const brain = s.firstDelta! - s.sent!;
    expect(brain).toBe(2000);
    expect(brain).toBeGreaterThan(s.audioStart! / 2); // the biggest contributor by far
  });
});

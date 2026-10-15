// @vitest-environment node
import type { DeskEvent, VoiceLatencyTurn } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { describeTurn, LatencyTracker, latencyLine, SPEECH_WAIT_MS } from "./latency";

/** A tracker on a hand-moved clock, with its timers held for the test to fire. */
function setup(model = "") {
  let clock = 10_000;
  const turns: VoiceLatencyTurn[] = [];
  const timers: { fn: () => void; ms: number; cleared?: boolean }[] = [];
  const tracker = new LatencyTracker({
    record: (t) => void turns.push(t),
    model: () => model,
    now: () => clock,
    setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimer: (h) => void (timers[h as number]!.cleared = true),
  });
  const at = (ms: number) => void (clock = ms);
  const event = (e: DeskEvent) => tracker.onEvent(e);
  /** A whole turn up to the request: speech ended at 10 000, decided 700 ms later, Whisper done at 11 100. */
  const ask = (trigger: "ptt" | "wake" = "ptt") => {
    tracker.start(trigger);
    at(11_100);
    tracker.heard({ speechEndAt: 10_000, endpointMs: 700, speechMs: 1500 });
    at(11_110);
    tracker.sent();
  };
  return { tracker, turns, timers, at, event, ask };
}

const done = (messageId: string): DeskEvent => ({
  type: "brain.done",
  messageId,
  text: "x",
  metrics: {} as never,
});

describe("LatencyTracker", () => {
  it("times a spoken turn from the end of speech to the first word, stage by stage", () => {
    const t = setup("claude-haiku-5-5");
    t.ask("wake");
    t.event({ type: "brain.start", messageId: "m1", channel: "desk-voice", text: "what's on today" });
    t.at(11_160);
    t.tracker.accepted("m1");
    t.at(12_000);
    t.event({ type: "brain.delta", messageId: "m1", text: "Two" });
    t.at(12_050);
    t.event({ type: "brain.delta", messageId: "m1", text: " meetings." }); // only the first delta counts
    t.at(12_120);
    t.tracker.speech("firstSentence", "m1");
    t.at(12_400);
    t.tracker.speech("sayReady", "m1");
    expect(t.turns).toEqual([]);
    t.at(12_430);
    t.tracker.speech("audioStart", "m1");
    expect(t.turns).toEqual([
      {
        at: new Date(10_000).toISOString(),
        trigger: "wake",
        speechMs: 1500,
        model: "claude-haiku-5-5",
        stages: {
          endpoint: 700,
          transcript: 1100,
          sent: 1110,
          accepted: 1160,
          firstDelta: 2000,
          firstSentence: 2120,
          sayReady: 2400,
          audioStart: 2430,
        },
      },
    ]);
    // Later sentences of the same reply don't make another turn.
    t.tracker.speech("audioStart", "m1");
    expect(t.turns).toHaveLength(1);
  });

  it("ignores other conversations' replies, but counts a desk-voice reply that started after asking (the morning brief)", () => {
    const t = setup();
    t.event({ type: "brain.delta", messageId: "early", text: "x" }); // before any turn: nothing
    t.ask();
    t.event({ type: "brain.start", messageId: "typed", channel: "desk-typed", text: "hi" });
    t.at(11_500);
    t.event({ type: "brain.delta", messageId: "typed", text: "Hello" });
    t.event({ type: "brain.start", messageId: "brief", channel: "desk-voice", text: "morning brief" });
    t.at(11_900);
    t.event({ type: "brain.delta", messageId: "brief", text: "Good morning." });
    t.tracker.accepted("m1");
    t.at(12_600);
    t.tracker.speech("audioStart", "brief");
    expect(t.turns[0]!.stages.firstDelta).toBe(1900);
    expect(t.turns[0]!.stages.audioStart).toBe(2600);
  });

  it("records a reply that ends without a word once the speaker has had its chance", () => {
    const t = setup();
    t.ask();
    t.tracker.accepted("m1");
    t.at(11_800);
    t.event({ type: "brain.delta", messageId: "m1", text: "Done" });
    t.event(done("m1"));
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(SPEECH_WAIT_MS);
    expect(t.turns).toEqual([]);
    t.timers[0]!.fn();
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.stages.audioStart).toBeUndefined();
    expect(t.turns[0]!.stages.firstDelta).toBe(1800);
  });

  it("a turn that reaches its first word after the reply ended clears the wait", () => {
    const t = setup();
    t.ask();
    t.tracker.accepted("m1");
    t.event(done("m1"));
    t.at(12_200);
    t.tracker.speech("audioStart", "m1");
    expect(t.timers[0]!.cleared).toBe(true);
    expect(t.turns).toHaveLength(1);
    t.timers[0]!.fn(); // too late: nothing more
    expect(t.turns).toHaveLength(1);
  });

  it("drops turns that never asked; a new turn records the one before if it had asked", () => {
    const t = setup();
    t.tracker.start("ptt");
    t.tracker.cancel(); // nothing heard
    t.tracker.start("ptt");
    t.tracker.start("wake"); // a new press while listening
    expect(t.turns).toEqual([]);
    t.ask();
    t.tracker.accepted("m1");
    t.tracker.start("ptt"); // talked over JARVIS before it said anything
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.stages.accepted).toBe(1110);
    // Marks for a turn that's gone change nothing.
    t.tracker.speech("audioStart", "m1");
    expect(t.turns).toHaveLength(1);
  });

  it("writes one JSON line per turn and a readable summary for the log", () => {
    const turn: VoiceLatencyTurn = {
      at: "2026-10-15T09:00:00.000Z",
      trigger: "ptt",
      speechMs: 1200,
      stages: { endpoint: 700, transcript: 1080, audioStart: 2310 },
    };
    expect(JSON.parse(latencyLine(turn))).toEqual(turn);
    expect(latencyLine(turn).endsWith("}\n")).toBe(true);
    expect(describeTurn(turn)).toBe(
      "voice latency: first word 2.31 s (endpoint 0.70 · transcript 1.08 · audioStart 2.31)",
    );
    expect(describeTurn({ ...turn, stages: { transcript: 900 } })).toMatch(/no first word/);
  });
});

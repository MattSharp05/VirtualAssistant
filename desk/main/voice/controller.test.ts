// @vitest-environment node
import type { DeskEvent } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { PushToTalk, REPLY_TIMEOUT_MS, type PushToTalkDeps, type SpeechLike } from "./controller";
import type { TurnTiming } from "../latency";
import type { ListenResult } from "./session";

const at = new Date("2026-10-15T09:00:00Z");
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake session whose listen() Matthew finishes by hand (`hear`), and a fake server. */
function setup(over: Partial<PushToTalkDeps> = {}) {
  const events: DeskEvent[] = [];
  const asked: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let finish: ((r: ListenResult) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const log: string[] = [];
  const deps: PushToTalkDeps = {
    listen: (opts) => {
      log.push(`listen keepThinking=${opts.keepThinking}`);
      if (opts.preRoll) log.push(`preRoll ${opts.preRoll.length}`);
      events.push({ type: "orb.state", state: "listening", amplitude: 0 });
      return new Promise<ListenResult>((resolve, reject) => {
        finish = (r) => {
          if (r.text) events.push({ type: "orb.state", state: "thinking" });
          else events.push({ type: "orb.state", state: "idle" });
          resolve(r);
        };
        fail = reject;
      });
    },
    stop: () => void log.push("stop"),
    cancel: () => {
      log.push("cancel");
      finish?.({ text: "", ms: 0, reason: "cancelled" });
    },
    chat: async (text) => {
      asked.push(text);
      return { messageId: "m1" };
    },
    publish: (e) => events.push(e),
    hint: () => "double-tap right ⌥",
    now: () => at,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => void timers.splice(0),
    ...over,
  };
  const ptt = new PushToTalk(deps);
  const hear = async (text: string, reason: ListenResult["reason"] = "silence") => {
    await tick();
    finish!({ text, ms: 300, reason });
    await tick();
  };
  const orb = () =>
    events.filter((e) => e.type === "orb.state").map((e) => (e.type === "orb.state" ? e.state : ""));
  const cards = () => events.flatMap((e) => (e.type === "card.show" ? [e.card] : []));
  return {
    ptt,
    events,
    asked,
    timers,
    log,
    hear,
    orb,
    cards,
    fail: (e: Error) => fail!(e),
    finish: (r: ListenResult) => finish!(r),
  };
}

const finishWith = (t: { finish(r: ListenResult): void }, r: ListenResult) => t.finish(r);

describe("PushToTalk", () => {
  it("the wake word (JD-43) starts the same turn with its pre-roll, only when idle", async () => {
    const states: string[] = [];
    const { ptt, log, hear, asked } = setup({ onState: (s) => states.push(s) });
    const preRoll = [new Int16Array(512), new Int16Array(512)];
    expect(ptt.wake(preRoll)).toBe(true);
    expect(ptt.wake(preRoll)).toBe(false); // already listening
    await hear("what's on today");
    expect(log).toEqual(["listen keepThinking=true", "preRoll 2"]);
    expect(asked).toEqual(["what's on today"]);
    expect(ptt.wake(preRoll)).toBe(false); // thinking
    ptt.onEvent({ type: "brain.done", messageId: "m1", text: "Two meetings.", metrics: {} as never });
    expect(states).toEqual(["listening", "thinking", "idle"]);
  });

  it("goes listening → thinking → idle, asking JARVIS what was heard", async () => {
    const t = setup();
    t.ptt.signal("toggle");
    expect(t.ptt.state).toBe("listening");
    await t.hear(" what's on today? ");
    expect(t.log).toEqual(["listen keepThinking=true"]);
    expect(t.events).toContainEqual({ type: "voice.transcript", text: "what's on today?", final: true });
    expect(t.asked).toEqual(["what's on today?"]);
    expect(t.ptt.state).toBe("thinking");

    t.ptt.onEvent({ type: "brain.start", messageId: "m1", channel: "desk-voice", text: "what's on today?" });
    t.ptt.onEvent({ type: "brain.delta", messageId: "m1", text: "Three" });
    expect(t.ptt.state).toBe("replying");
    t.ptt.onEvent({ type: "brain.done", messageId: "other", text: "x", metrics: {} as never });
    expect(t.ptt.state).toBe("replying");
    t.ptt.onEvent({ type: "brain.done", messageId: "m1", text: "Three things.", metrics: {} as never });
    expect(t.ptt.state).toBe("idle");
    expect(t.orb()).toEqual(["listening", "thinking", "idle"]);
    expect(t.timers).toEqual([]);
  });

  it("a second double-tap while listening cancels: nothing is sent, no card", async () => {
    const t = setup();
    t.ptt.signal("toggle");
    await tick();
    t.ptt.signal("toggle");
    await tick();
    expect(t.log).toEqual(["listen keepThinking=true", "cancel"]);
    expect(t.ptt.state).toBe("idle");
    expect(t.asked).toEqual([]);
    expect(t.cards()).toEqual([]);
    expect(t.orb()).toEqual(["listening", "idle"]);
    // …and the next double-tap listens again.
    t.ptt.signal("toggle");
    await t.hear("hello");
    expect(t.asked).toEqual(["hello"]);
  });

  it("shows “didn't catch that” when nothing was heard", async () => {
    const t = setup();
    t.ptt.signal("toggle");
    await t.hear("", "no-speech");
    expect(t.ptt.state).toBe("idle");
    expect(t.asked).toEqual([]);
    expect(t.cards()).toMatchObject([{ title: "Didn't catch that" }]);
    expect(t.cards()[0]!.body).toContain("Double-tap right ⌥ and try again.");
    expect(t.events.some((e) => e.type === "voice.transcript")).toBe(false);
  });

  it("shows why when listening or asking fails, and the orb rests", async () => {
    const t = setup({ chat: async () => Promise.reject(new Error("JARVIS isn't connected")) });
    t.ptt.signal("toggle");
    await t.hear("hello");
    expect(t.cards()).toMatchObject([{ title: "Couldn't reach JARVIS", body: "JARVIS isn't connected" }]);
    expect(t.ptt.state).toBe("idle");
    expect(t.orb().at(-1)).toBe("idle");

    const broken = setup();
    broken.ptt.signal("toggle");
    await tick();
    broken.fail(new Error("Mic off"));
    await tick();
    expect(broken.cards()).toMatchObject([{ title: "Voice isn't working", body: "Mic off" }]);
    expect(broken.ptt.state).toBe("idle");
  });

  it("follows a reply that finishes before the chat request answers", async () => {
    let answer!: (r: { messageId: string }) => void;
    const t = setup({ chat: () => new Promise((r) => (answer = r)) });
    t.ptt.signal("toggle");
    await t.hear("quick one");
    t.ptt.onEvent({ type: "brain.done", messageId: "m9", text: "Done.", metrics: {} as never });
    expect(t.ptt.state).toBe("thinking");
    answer({ messageId: "m9" });
    await tick();
    expect(t.ptt.state).toBe("idle");
    expect(t.orb().at(-1)).toBe("idle");
  });

  it("claims its reply from brain.start, and a brain.error shows a card", async () => {
    let answer!: (r: { messageId: string }) => void;
    const t = setup({ chat: () => new Promise((r) => (answer = r)) });
    t.ptt.signal("toggle");
    await t.hear("hello");
    t.ptt.onEvent({ type: "brain.start", messageId: "brief", channel: "desk-voice", text: "Good morning…" });
    t.ptt.onEvent({ type: "brain.start", messageId: "m2", channel: "desk-voice", text: "hello" });
    t.ptt.onEvent({ type: "brain.done", messageId: "brief", text: "brief", metrics: {} as never });
    expect(t.ptt.state).toBe("thinking");
    t.ptt.onEvent({ type: "brain.error", messageId: "m2", error: "claude exited" });
    expect(t.ptt.state).toBe("idle");
    expect(t.cards()).toMatchObject([{ title: "JARVIS couldn't answer", body: "claude exited" }]);
    answer({ messageId: "m2" });
    await tick();
    expect(t.ptt.state).toBe("idle");
  });

  it("doesn't leave the orb thinking if the reply never comes", async () => {
    const t = setup();
    t.ptt.signal("toggle");
    await t.hear("hello");
    expect(t.timers.map((x) => x.ms)).toEqual([REPLY_TIMEOUT_MS]);
    t.timers[0]!.fn();
    expect(t.ptt.state).toBe("idle");
    expect(t.orb().at(-1)).toBe("idle");
  });

  it("hold to talk: letting go sends, another key cancels", async () => {
    const t = setup();
    t.ptt.signal("hold-start");
    t.ptt.signal("hold-start");
    t.ptt.signal("hold-end");
    expect(t.log).toEqual(["listen keepThinking=true", "stop"]);
    await t.hear("hello", "stopped");
    expect(t.asked).toEqual(["hello"]);

    const c = setup();
    c.ptt.signal("hold-start");
    await tick();
    c.ptt.signal("hold-cancel");
    await tick();
    expect(c.log).toEqual(["listen keepThinking=true", "cancel"]);
    expect(c.ptt.state).toBe("idle");
  });

  it("a new double-tap while JARVIS is thinking starts a new question", async () => {
    const t = setup();
    t.ptt.signal("toggle");
    await t.hear("first");
    t.ptt.signal("toggle");
    expect(t.ptt.state).toBe("listening");
    // The first reply finishing doesn't end the new listen.
    t.ptt.onEvent({ type: "brain.done", messageId: "m1", text: "x", metrics: {} as never });
    expect(t.ptt.state).toBe("listening");
    await t.hear("second");
    expect(t.asked).toEqual(["first", "second"]);
  });

  it("tells the latency tracker (JD-48) where each turn has got to", async () => {
    const calls: string[] = [];
    const timing: TurnTiming = {
      start: (trigger) => void calls.push(`start ${trigger}`),
      heard: (h) => void calls.push(`heard ${h.speechEndAt} ${h.endpointMs} ${h.speechMs}`),
      sent: () => void calls.push("sent"),
      accepted: (id) => void calls.push(`accepted ${id}`),
      cancel: () => void calls.push("cancel"),
    };
    const t = setup({ timing });
    t.ptt.signal("toggle");
    await tick();
    finishWith(t, {
      text: "what's on today",
      ms: 300,
      reason: "silence",
      speechEndAt: 5000,
      endpointMs: 704,
      speechMs: 1200,
    });
    await tick();
    expect(calls).toEqual(["start ptt", "heard 5000 704 1200", "sent", "accepted m1"]);

    // Cancelled, nothing heard, or a wake-word turn.
    calls.length = 0;
    t.ptt.onEvent({ type: "brain.done", messageId: "m1", text: "x", metrics: {} as never });
    t.ptt.signal("toggle");
    t.ptt.signal("toggle");
    await tick();
    expect(calls).toEqual(["start ptt", "cancel"]);
    calls.length = 0;
    t.ptt.wake([new Int16Array(512)]);
    await t.hear("");
    expect(calls).toEqual(["start wake", "cancel"]);
  });

  describe("with spoken replies (JD-38)", () => {
    /** A fake speaker: busy until the test says it has finished talking. */
    function fakeSpeech() {
      const log: string[] = [];
      let finish: (() => void) | undefined;
      const speech: SpeechLike & { busy: boolean; talked(): void } = {
        busy: false,
        drained: () => new Promise<void>((r) => (finish = r)),
        interrupt: () => {
          log.push("interrupt");
          speech.busy = false;
          finish?.();
        },
        talked: () => {
          speech.busy = false;
          finish?.();
        },
      };
      return { speech, log };
    }

    it("stays replying until the last sentence has been said; the speaker rests the orb", async () => {
      const { speech } = fakeSpeech();
      const t = setup({ speech });
      t.ptt.signal("toggle");
      await t.hear("what's on today?");
      t.ptt.onEvent({
        type: "brain.start",
        messageId: "m1",
        channel: "desk-voice",
        text: "what's on today?",
      });
      t.ptt.onEvent({ type: "brain.delta", messageId: "m1", text: "Three things." });
      speech.busy = true;
      t.ptt.onEvent({ type: "brain.done", messageId: "m1", text: "Three things.", metrics: {} as never });
      expect(t.ptt.state).toBe("replying");
      expect(t.timers).toEqual([]); // the reply has arrived: no timeout while it's spoken
      speech.talked();
      await tick();
      expect(t.ptt.state).toBe("idle");
      expect(t.orb()).toEqual(["listening", "thinking"]);
    });

    it("a reply with nothing to say finishes at once", async () => {
      const { speech } = fakeSpeech();
      const t = setup({ speech });
      t.ptt.signal("toggle");
      await t.hear("show me the code");
      t.ptt.onEvent({ type: "brain.done", messageId: "m1", text: "```x```", metrics: {} as never });
      expect(t.ptt.state).toBe("idle");
      expect(t.orb().at(-1)).toBe("idle");
    });

    it("⌥⌥ while JARVIS talks stops it and listens again", async () => {
      const { speech, log } = fakeSpeech();
      const t = setup({ speech });
      t.ptt.signal("toggle");
      await t.hear("tell me a story");
      t.ptt.onEvent({ type: "brain.delta", messageId: "m1", text: "Once upon a time." });
      speech.busy = true;
      t.ptt.onEvent({ type: "brain.done", messageId: "m1", text: "…", metrics: {} as never });
      t.ptt.signal("toggle");
      expect(log).toEqual(["interrupt"]);
      expect(t.ptt.state).toBe("listening");
      await tick();
      // The interrupted reply's end doesn't touch the new listen.
      expect(t.ptt.state).toBe("listening");
      await t.hear("what's next?");
      expect(t.asked).toEqual(["tell me a story", "what's next?"]);
    });

    it("⌥⌥ while a brief is spoken (no question of its own) interrupts it too", async () => {
      const { speech, log } = fakeSpeech();
      speech.busy = true;
      const t = setup({ speech });
      t.ptt.signal("toggle");
      expect(log).toEqual(["interrupt"]);
      expect(t.ptt.state).toBe("listening");
    });
  });
});

// @vitest-environment node
import type { DeskEvent } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { PushToTalk, REPLY_TIMEOUT_MS, type PushToTalkDeps } from "./controller";
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
  return { ptt, events, asked, timers, log, hear, orb, cards, fail: (e: Error) => fail!(e) };
}

describe("PushToTalk", () => {
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
});

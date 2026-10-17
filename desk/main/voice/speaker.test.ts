// @vitest-environment node
import type { DeskEvent } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { FIRST_CLAUSE_CHARS, PREWARM_EVERY_MS, Speaker, type SpeakerDeps } from "./speaker";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A process the test finishes by hand. */
interface Fake {
  name: string;
  finish(): void;
  fail(err: Error): void;
  stopped: boolean;
}

/** A Speaker over a fake `say` and `afplay`; the test decides when each finishes. */
function setup(over: Partial<SpeakerDeps> = {}) {
  const events: DeskEvent[] = [];
  const log: string[] = [];
  const says: Fake[] = [];
  const plays: Fake[] = [];
  const removed: string[] = [];
  const intervals: (() => void)[] = [];
  let clock = 0;
  const fake = (list: Fake[], name: string) => {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
    const f: Fake = {
      name,
      finish: () => resolve(),
      fail: (e) => reject(e),
      stopped: false,
    };
    list.push(f);
    return {
      done,
      stop: () => {
        f.stopped = true;
        log.push(`stop ${name}`);
        reject(new Error("killed"));
      },
    };
  };
  const deps: SpeakerDeps = {
    synthesize: (text, file) => {
      log.push(`say ${text} → ${file}`);
      return fake(says, text);
    },
    play: (file) => {
      log.push(`play ${file}`);
      return fake(plays, file);
    },
    envelope: async () => [0.2, 0.9, 0.5],
    remove: (file) => void removed.push(file),
    file: (n) => `/tmp/${n}.aiff`,
    speakReplies: () => true,
    publish: (e) => void events.push(e),
    now: () => clock,
    setInterval: (fn) => intervals.push(fn) - 1,
    clearInterval: (h) => void (intervals[h as number] = () => {}),
    ...over,
  };
  const speaker = new Speaker(deps);
  const orb = () =>
    events.flatMap((e) =>
      e.type === "orb.state" ? [e.state === "speaking" ? `speaking ${e.amplitude}` : e.state] : [],
    );
  /** Lets the fake `say` number i finish, and the speaker react. */
  const said = async (i: number) => {
    says[i]!.finish();
    await tick();
    await tick();
  };
  const played = async (i: number) => {
    plays[i]!.finish();
    await tick();
    await tick();
  };
  const advance = (ms: number) => {
    clock += ms;
    intervals.forEach((fn) => fn());
  };
  const reply = (id: string, channel: "desk-voice" | "desk-typed", ...chunks: string[]) => {
    speaker.onEvent({ type: "brain.start", messageId: id, channel, text: "q" });
    for (const text of chunks) speaker.onEvent({ type: "brain.delta", messageId: id, text });
  };
  const done = (id: string) =>
    speaker.onEvent({ type: "brain.done", messageId: id, text: "", metrics: {} as never });
  return {
    speaker,
    events,
    log,
    says,
    plays,
    removed,
    orb,
    said,
    played,
    advance,
    reply,
    done,
    at: (ms: number) => void (clock = ms),
  };
}

describe("Speaker", () => {
  it("plays sentences in order, synthesising the next while the current one plays", async () => {
    const t = setup();
    t.speaker.say("One.");
    t.speaker.say("Two.");
    t.speaker.say("Three.");
    // One `say` at a time, in order.
    expect(t.log).toEqual(["say One. → /tmp/1.aiff"]);
    await t.said(0);
    expect(t.log).toEqual(["say One. → /tmp/1.aiff", "play /tmp/1.aiff", "say Two. → /tmp/2.aiff"]);
    await t.said(1);
    // Two is ready while One plays; Three waits (only the next sentence is synthesised ahead).
    expect(t.log).toHaveLength(3);
    await t.played(0);
    expect(t.removed).toEqual(["/tmp/1.aiff"]);
    expect(t.log.slice(3)).toEqual(["play /tmp/2.aiff", "say Three. → /tmp/3.aiff"]);
    await t.said(2);
    await t.played(1);
    expect(t.log.slice(5)).toEqual(["play /tmp/3.aiff"]);
    await t.played(2);
    expect(t.speaker.busy).toBe(false);
    expect(t.orb().at(-1)).toBe("idle");
  });

  it("pulses the orb with the sentence's envelope at 30 Hz", async () => {
    const t = setup();
    t.speaker.say("Hello.");
    await t.said(0);
    expect(t.orb()).toEqual(["speaking 0.2"]);
    t.advance(34);
    t.advance(33);
    t.advance(1000);
    expect(t.orb()).toEqual(["speaking 0.2", "speaking 0.9", "speaking 0.5", "speaking 0"]);
    await t.played(0);
    expect(t.orb().at(-1)).toBe("idle");
    t.advance(34); // the ticker stopped with the sentence
    expect(t.orb().at(-1)).toBe("idle");
  });

  it("interrupt stops playback at once, kills the synthesis ahead and clears the queue", async () => {
    const t = setup();
    t.speaker.say("One.");
    t.speaker.say("Two.");
    t.speaker.say("Three.");
    await t.said(0);
    const drained = t.speaker.drained();
    t.speaker.interrupt();
    expect(t.plays[0]!.stopped).toBe(true);
    expect(t.says[1]!.stopped).toBe(true);
    expect(t.removed).toEqual(["/tmp/1.aiff", "/tmp/2.aiff", "/tmp/3.aiff"]);
    expect(t.speaker.busy).toBe(false);
    await drained;
    await tick();
    expect(t.log.filter((l) => l.startsWith("say") || l.startsWith("play"))).toHaveLength(3);
    // Listening follows an interrupt: the orb isn't sent to idle in between.
    expect(t.orb()).not.toContain("idle");
    // It speaks again afterwards.
    t.speaker.say("Four.");
    expect(t.log.at(-1)).toBe("say Four. → /tmp/4.aiff");
  });

  it("speaks desk-voice replies sentence by sentence as they stream", async () => {
    const t = setup();
    t.reply("m1", "desk-voice", "You have two meetings", " today. The first is at 10:30");
    expect(t.log).toEqual(["say You have two meetings today. → /tmp/1.aiff"]);
    expect(t.speaker.busy).toBe(true);
    t.done("m1");
    await t.said(0);
    expect(t.says.map((s) => s.name)).toEqual(["You have two meetings today.", "The first is at 10:30"]);
    await t.said(1);
    await t.played(0);
    await t.played(1);
    expect(t.speaker.busy).toBe(false);
  });

  it("doesn't speak typed turns, or anything while speakReplies is off", () => {
    const t = setup();
    t.reply("m1", "desk-typed", "Typed answer. ");
    t.done("m1");
    expect(t.log).toEqual([]);
    const off = setup({ speakReplies: () => false });
    off.reply("m2", "desk-voice", "Voice answer. ");
    off.done("m2");
    expect(off.log).toEqual([]);
    expect(off.speaker.busy).toBe(false);
  });

  it("says a browser task's question or result (browser.say), unless speakReplies is off (JD-60)", async () => {
    const t = setup();
    t.speaker.onEvent({ type: "browser.say", text: "Lilia has 8pm free. Shall I book it?" });
    expect(t.says.map((s) => s.name)).toEqual(["Lilia has 8pm free."]);
    await t.said(0);
    expect(t.says.map((s) => s.name)).toEqual(["Lilia has 8pm free.", "Shall I book it?"]);
    const off = setup({ speakReplies: () => false });
    off.speaker.onEvent({ type: "browser.say", text: "Booked." });
    expect(off.log).toEqual([]);
  });

  it("drops the rest of an interrupted reply", async () => {
    const t = setup();
    t.reply("m1", "desk-voice", "First sentence. ");
    t.speaker.interrupt();
    t.speaker.onEvent({ type: "brain.delta", messageId: "m1", text: "Second sentence. " });
    t.done("m1");
    expect(t.says.map((s) => s.name)).toEqual(["First sentence."]);
  });

  it("skips a sentence `say` couldn't write and goes on", async () => {
    const t = setup();
    t.speaker.say("Bad.");
    t.speaker.say("Good.");
    t.says[0]!.fail(new Error("say exited with 1"));
    await tick();
    await tick();
    expect(t.removed).toEqual(["/tmp/1.aiff"]);
    expect(t.log.at(-1)).toBe("say Good. → /tmp/2.aiff");
    await t.said(1);
    expect(t.log.at(-1)).toBe("play /tmp/2.aiff");
  });

  it("drained() waits for the open reply and the last sentence", async () => {
    const t = setup();
    let done = false;
    t.reply("m1", "desk-voice", "Hi. ");
    void t.speaker.drained().then(() => (done = true));
    await t.said(0);
    t.done("m1");
    await tick();
    expect(done).toBe(false);
    await t.played(0);
    expect(done).toBe(true);
  });

  it("marks each reply's first sentence, its file ready and its first sound for the latency tracker (JD-48)", async () => {
    const marks: string[] = [];
    const t = setup({ onMark: (stage, id) => void marks.push(`${stage} ${id}`) });
    t.reply("m1", "desk-voice", "One. Two. ");
    expect(marks).toEqual(["firstSentence m1"]);
    await t.said(0);
    expect(marks).toEqual(["firstSentence m1", "sayReady m1", "audioStart m1"]);
    await t.said(1);
    await t.played(0);
    t.speaker.onEvent({ type: "brain.delta", messageId: "m1", text: "Three. " });
    t.done("m1");
    await t.said(2);
    await t.played(1);
    expect(marks).toHaveLength(3); // only the first sentence of a reply
    t.reply("m2", "desk-voice", "Next reply. ");
    expect(marks.at(-1)).toBe("firstSentence m2");
  });

  it("starts a long first sentence at its last comma so JARVIS talks sooner", () => {
    const t = setup();
    const long = "You have three meetings this afternoon, starting with the design review at two";
    t.reply("m1", "desk-voice", long.slice(0, 40));
    expect(t.log).toEqual([]);
    t.speaker.onEvent({ type: "brain.delta", messageId: "m1", text: `${long.slice(40)} and then` });
    expect(long.length + 9).toBeGreaterThanOrEqual(FIRST_CLAUSE_CHARS);
    expect(t.log).toEqual(["say You have three meetings this afternoon, → /tmp/1.aiff"]);
    t.speaker.onEvent({ type: "brain.delta", messageId: "m1", text: " the standup, with Jo. Done." });
    t.done("m1");
    expect(t.speaker.busy).toBe(true);
  });

  it("prewarm runs one throwaway `say` while nothing is being said, at most once a minute", async () => {
    const t = setup();
    t.speaker.prewarm();
    expect(t.log).toEqual(["say Ready. → /tmp/0.aiff"]);
    await t.said(0);
    expect(t.removed).toEqual(["/tmp/0.aiff"]);
    expect(t.speaker.busy).toBe(false);
    expect(t.orb()).toEqual([]); // nothing played
    t.speaker.prewarm();
    expect(t.log).toHaveLength(1);
    t.at(PREWARM_EVERY_MS + 1);
    t.speaker.say("Hello.");
    t.speaker.prewarm(); // talking (and say just ran): no
    expect(t.log.filter((l) => l.startsWith("say Ready."))).toHaveLength(1);
  });
});

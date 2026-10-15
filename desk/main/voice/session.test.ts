// @vitest-environment node
import type { DeskEvent } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import type { Mic } from "../audio/recorder";
import { record, type Segment } from "./fixtures";
import { VoiceSession, type VoiceSessionDeps } from "./session";

/** A mic that plays a recording; the fake VAD looks each frame's probability up. */
function setup(segments: Segment[], over: Partial<VoiceSessionDeps> = {}) {
  const { frames, probabilities } = record(segments);
  const prob = new Map(frames.map((f, i) => [f, probabilities[i]]));
  const events: DeskEvent[] = [];
  const log: string[] = [];
  let clock = 1000;
  const mic = (): Mic => {
    let i = 0;
    return {
      read: async () => {
        if (i >= frames.length) throw new Error("recording over");
        return frames[i++];
      },
      stop: () => void log.push("mic stop"),
    };
  };
  const session = new VoiceSession({
    prepare: async () => {
      log.push("prepare");
      return {
        vad: { probability: async (f) => prob.get(f) ?? 0, reset: () => void log.push("vad reset") },
        transcribe: async (audio) => {
          log.push(`transcribe ${audio.length}`);
          clock += 350;
          return "what's on my calendar tomorrow";
        },
      };
    },
    openMic: async () => mic(),
    publish: (e) => events.push(e),
    now: () => clock,
    ...over,
  });
  const orb = () =>
    events.filter((e) => e.type === "orb.state").map((e) => (e.type === "orb.state" ? e.state : ""));
  return { session, events, log, orb, frames };
}

const speech: Segment[] = [
  ["silence", 500],
  ["speech", 1200],
  ["silence", 1500],
];

describe("VoiceSession.listen", () => {
  it("listens until the silence, transcribes, and drives the orb", async () => {
    const { session, events, log, orb } = setup(speech);
    const result = await session.listen();
    expect(result).toEqual({ text: "what's on my calendar tomorrow", ms: 350, reason: "silence" });
    expect(log).toEqual(["prepare", "vad reset", "mic stop", expect.stringMatching(/^transcribe \d+$/)]);
    // listening (with the level ~20/s) → thinking → idle, compressed to the changes:
    expect(orb().filter((s, i, a) => s !== a[i - 1])).toEqual(["listening", "thinking", "idle"]);
    const levels = events.filter((e) => e.type === "orb.state" && e.state === "listening");
    expect(levels.length).toBeGreaterThan(40);
    expect(Math.max(...levels.map((e) => (e.type === "orb.state" ? (e.amplitude ?? 0) : 0)))).toBeGreaterThan(
      0.5,
    );
    expect(session.state).toBe("idle");
  });

  it("can leave the orb thinking for the server's reply", async () => {
    const { session, orb } = setup(speech);
    await session.listen({ keepThinking: true });
    expect(orb().at(-1)).toBe("thinking");
  });

  it("returns nothing (and doesn't transcribe) when no one spoke", async () => {
    const { session, log, orb } = setup([["noise", 9000]]);
    expect(await session.listen()).toEqual({ text: "", ms: 0, reason: "no-speech" });
    expect(log.some((l) => l.startsWith("transcribe"))).toBe(false);
    expect(orb().at(-1)).toBe("idle");
  });

  it("prepares the models once, and a second listen() while one runs shares it", async () => {
    const { session, log } = setup(speech);
    const a = session.listen();
    const b = session.listen();
    expect(b).toBe(a);
    await a;
    await session.listen(); // a fresh mic, same engine
    expect(log.filter((l) => l === "prepare")).toHaveLength(1);
  });

  it("stop() ends early and transcribes what was said", async () => {
    let i = 0;
    // A mic on which Matthew lets go after 1 s (what JD-31's hold-to-talk will do).
    const t = setup([["speech", 5000]], {
      openMic: async () => ({
        read: async () => {
          if (i === 31) t.session.stop();
          return t.frames[i++];
        },
        stop: () => {},
      }),
    });
    const result = await t.session.listen();
    expect(result.reason).toBe("stopped");
    expect(result.text).not.toBe("");
    expect(i).toBe(32);
  });

  it("puts the orb back to idle and rethrows when something breaks", async () => {
    const noMic = setup(speech, { openMic: async () => Promise.reject(new Error("Mic off")) });
    await expect(noMic.session.listen()).rejects.toThrow("Mic off");
    expect(noMic.orb()).toEqual(["idle"]);

    const noModels = setup(speech, { prepare: async () => Promise.reject(new Error("offline")) });
    await expect(noModels.session.listen()).rejects.toThrow("offline");
    expect(noModels.session.state).toBe("idle");
  });
});

it("warmUp() prepares the models ahead of the first listen", async () => {
  let prepared = 0;
  const session = new VoiceSession({
    prepare: async () => {
      prepared++;
      return { vad: { probability: async () => 0, reset: () => {} }, transcribe: async () => "" };
    },
    openMic: async () => Promise.reject(new Error("unused")),
    publish: () => {},
  });
  await session.warmUp();
  await session.warmUp();
  expect(prepared).toBe(1);
});

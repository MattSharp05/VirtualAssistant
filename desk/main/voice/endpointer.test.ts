// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FRAME_LENGTH } from "../audio/recorder";
import { Endpointer, frameLevel, type EndpointerEvent } from "./endpointer";
import { framesFor, record, type Segment } from "./fixtures";

/** Plays a recording through a fresh endpointer; returns every event with the frame it came on. */
function play(segments: Segment[], ep = new Endpointer()) {
  const { frames, probabilities } = record(segments);
  const events: (EndpointerEvent & { frame: number })[] = [];
  frames.forEach((f, i) => {
    for (const e of ep.push(f, probabilities[i])) events.push({ ...e, frame: i });
  });
  const end = events.find((e) => e.type === "end");
  return { ep, events, end, starts: events.filter((e) => e.type === "start") };
}

describe("Endpointer", () => {
  it("ends 700 ms after speech stops, keeping a little audio either side", () => {
    const { end, starts, ep } = play([
      ["silence", 1000],
      ["speech", 1500],
      ["silence", 2000],
    ]);
    expect(starts).toHaveLength(1);
    expect(ep.state).toBe("done");
    expect(end).toMatchObject({ type: "end", reason: "silence" });
    // The frame on which 700 ms of silence had passed.
    expect(end!.frame).toBe(framesFor(1000) + framesFor(1500) + framesFor(700) - 1);
    // Utterance = 300 ms pre-roll + the speech + 250 ms tail (rounded to whole frames).
    const audio = end!.type === "end" ? end!.audio! : new Int16Array();
    expect(audio.length / FRAME_LENGTH).toBe(framesFor(300) + framesFor(1500) + framesFor(250));
    expect(end!.type === "end" && end!.speechMs).toBeGreaterThanOrEqual(1500);
  });

  it("doesn't end on a short pause between words", () => {
    const { end, starts } = play([
      ["speech", 800],
      ["pause", 400],
      ["speech", 800],
      ["silence", 1000],
    ]);
    expect(starts).toHaveLength(1);
    expect(end!.frame).toBe(framesFor(800) + framesFor(400) + framesFor(800) + framesFor(700) - 1);
  });

  it("stops at 30 s however long Matthew keeps talking", () => {
    const { end } = play([["speech", 35_000]]);
    expect(end).toMatchObject({ reason: "max" });
    expect(end!.frame).toBe(framesFor(30_000) - 1);
  });

  it("never starts on noise only, and gives up after 8 s", () => {
    const { end, starts } = play([["noise", 12_000]]);
    expect(starts).toEqual([]);
    expect(end).toMatchObject({ reason: "no-speech" });
    expect(end!.type === "end" && end!.audio).toBeUndefined();
    expect(end!.frame).toBe(framesFor(8_000) - 1);
  });

  it("drops a blip under 300 ms and starts on the real speech after it", () => {
    const { starts, end } = play([
      ["silence", 500],
      ["speech", 200],
      ["silence", 900],
      ["speech", 1000],
      ["silence", 1000],
    ]);
    expect(starts).toHaveLength(1);
    expect(starts[0].frame).toBeGreaterThan(framesFor(500) + framesFor(200) + framesFor(900));
    expect(end).toMatchObject({ reason: "silence" });
  });

  it("reports the level 20 times a second of audio, louder while speaking", () => {
    const { events, end } = play([
      ["silence", 1000],
      ["speech", 1000],
      ["silence", 1000],
    ]);
    const levels = events.filter((e) => e.type === "level");
    // One per 50 ms of audio up to the end (~2.7 s: 1 s silence + 1 s speech + 700 ms).
    const seconds = ((end!.frame + 1) * FRAME_LENGTH) / 16_000;
    expect(levels).toHaveLength(Math.floor(seconds * 20));
    const at = (ms: number) => levels.find((l) => l.frame >= framesFor(ms)) as { level: number };
    expect(at(500).level).toBeLessThan(0.1);
    expect(at(1500).level).toBeGreaterThan(0.6);
    for (const l of levels) expect((l as { level: number }).level).toBeGreaterThanOrEqual(0);
  });

  it("flush() hands over what was said so far, or nothing before speech started", () => {
    const ep = new Endpointer();
    const { frames, probabilities } = record([["speech", 600]]);
    frames.forEach((f, i) => ep.push(f, probabilities[i]));
    const flushed = ep.flush();
    expect(flushed.reason).toBe("stopped");
    expect(flushed.audio!.length).toBeGreaterThan(0);
    expect(ep.push(frames[0], 0.9)).toEqual([]);

    const quiet = new Endpointer();
    quiet.push(new Int16Array(FRAME_LENGTH), 0);
    expect(quiet.flush()).toEqual({ reason: "no-speech" });
  });
});

it("frameLevel maps silence to 0 and a loud frame to 1", () => {
  expect(frameLevel(new Int16Array(512))).toBe(0);
  expect(frameLevel(new Int16Array(512).fill(20_000))).toBe(1);
  expect(frameLevel(new Int16Array(512).fill(300))).toBeGreaterThan(0);
});

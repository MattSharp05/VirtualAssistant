import { describe, expect, it } from "vitest";
import {
  FLICK_SPEED,
  GestureRecognizer,
  LOST_MS,
  nextPinch,
  PINCH_OFF,
  PINCH_ON,
  releaseVelocity,
  scaleRect,
  type GestureEvent,
} from "./gestures";
import { CAMERA_ASPECT } from "./mapping";
import type { HandSample } from "./tracker";

const SCREEN = { width: 1000, height: 800 };
const FRAME_MS = 1000 / 30;
/** A palm at normal desk distance: ~12% of the frame's height across the knuckles. */
const PALM = 0.12;

/** Deterministic jitter (mulberry32) of a resting fingertip: ±0.05% of the frame, after MediaPipe's own smoothing. */
function jitter(seed: number, amp = 0.0005) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amp;
  };
}

/**
 * A recorded-style hand: the pinch point at (x, y) in camera space and the thumb–index gap as a share
 * of the palm's width, with landmark jitter on both tips.
 */
function hand(name: string, x: number, y: number, gap: number, noise = jitter(1)): HandSample {
  const half = (gap * PALM) / 2 / CAMERA_ASPECT; // the gap is horizontal
  return {
    hand: name,
    thumb: { x: x - half + noise(), y: y + noise() },
    index: { x: x + half + noise(), y: y + noise() },
    palm: PALM,
  };
}

/** Plays frames through a recognizer; returns every event with its frame number. */
function play(frames: HandSample[][], g = new GestureRecognizer(), from = 0) {
  const out: (GestureEvent & { frame: number })[] = [];
  frames.forEach((samples, i) =>
    out.push(...g.update(samples, (from + i) * FRAME_MS, SCREEN).map((e) => ({ ...e, frame: from + i }))),
  );
  return out;
}

const types = (events: { type: string }[]) => events.map((e) => e.type).filter((t) => t !== "pinchmove");

/** A fixture: open hand, close to a pinch, hold, drag `dx` per frame for `steps` frames, open. */
function pinchDrag(dxPerFrame: number, steps: number, seed = 3) {
  const noise = jitter(seed);
  const frames: HandSample[][] = [];
  for (const gap of [1, 0.8, 0.6, 0.4, 0.3, 0.2]) frames.push([hand("Right", 0.5, 0.5, gap, noise)]);
  for (let i = 0; i < 5; i++) frames.push([hand("Right", 0.5, 0.5, 0.2, noise)]);
  let x = 0.5;
  for (let i = 0; i < steps; i++) {
    x -= dxPerFrame; // camera-left is screen-right
    frames.push([hand("Right", x, 0.5, 0.2, noise)]);
  }
  frames.push([hand("Right", x - dxPerFrame, 0.5, 0.8, noise)]);
  return frames;
}

describe("nextPinch (hysteresis)", () => {
  const at = (ratio: number) => hand("Right", 0.5, 0.5, ratio, () => 0);

  it(`starts below ${PINCH_ON} × the palm and ends above ${PINCH_OFF} ×`, () => {
    expect(nextPinch(false, at(0.5))).toBe(false);
    expect(nextPinch(false, at(0.4))).toBe(false);
    expect(nextPinch(false, at(0.3))).toBe(true);
    expect(nextPinch(true, at(0.4))).toBe(true);
    expect(nextPinch(true, at(0.44))).toBe(true);
    expect(nextPinch(true, at(0.5))).toBe(false);
  });

  it("keeps the state when the palm's width is unknown", () => {
    expect(nextPinch(false, { ...at(0.1), palm: undefined })).toBe(false);
    expect(nextPinch(true, { ...at(0.9), palm: undefined })).toBe(true);
  });
});

describe("GestureRecognizer", () => {
  it("pinches once, without flicker, while the gap wobbles between the two thresholds", () => {
    const noise = jitter(9);
    const gaps = [1, 0.6, 0.38, 0.42, 0.37, 0.3, 0.4, 0.43, 0.38, 0.43, 0.41, 0.5, 0.42, 0.38, 0.9];
    const events = play(gaps.map((gap) => [hand("Right", 0.5, 0.5, gap, noise)]));
    expect(types(events)).toEqual(["pinchstart", "pinchend"]);
    // Started at 0.3 (frame 5), ended at 0.5 (frame 11); 0.38 again after doesn't restart it.
    expect(events.find((e) => e.type === "pinchstart")!.frame).toBe(5);
    expect(events.find((e) => e.type === "pinchend")!.frame).toBe(11);
  });

  it("reports the pinch point on screen, mirrored, and drags it", () => {
    const events = play(pinchDrag(0.01, 20));
    const start = events.find((e) => e.type === "pinchstart")!;
    expect(start).toMatchObject({ hand: "Right" });
    if (start.type !== "pinchstart") throw new Error();
    expect(start.point.x).toBeCloseTo(500, -1);
    expect(start.point.y).toBeCloseTo(400, -1);
    const moves = events.filter((e) => e.type === "pinchmove");
    expect(moves.length).toBeGreaterThan(20);
    const last = moves.at(-1)!;
    if (last.type !== "pinchmove") throw new Error();
    // 20 frames × 0.01 of the camera = 0.2 / 0.7 of the screen ≈ 286 px to the right (smoothing lags a bit).
    expect(last.point.x).toBeGreaterThan(500 + 240);
    expect(last.point.x).toBeLessThan(500 + 300);
  });

  it(`flicks on a release faster than ${FLICK_SPEED} screen widths a second`, () => {
    // 0.07 of the camera a frame ≈ 3 screen widths a second.
    const end = play(pinchDrag(0.07, 4)).find((e) => e.type === "pinchend")!;
    expect(end).toMatchObject({ type: "pinchend", flick: true });
    if (end.type !== "pinchend") throw new Error();
    expect(end.velocity.x / SCREEN.width).toBeGreaterThan(FLICK_SPEED);
  });

  it("drops (no flick) on a slow release, or a fast move that stopped before letting go", () => {
    const slow = play(pinchDrag(0.01, 20)).find((e) => e.type === "pinchend");
    expect(slow).toMatchObject({ flick: false });
    const frames = pinchDrag(0.07, 4);
    const release = frames.pop()!;
    const still = frames.at(-1)!;
    for (let i = 0; i < 8; i++) frames.push(still);
    frames.push([
      { ...release[0], thumb: still[0].thumb, index: { ...still[0].index, x: still[0].index.x + 0.1 } },
    ]);
    expect(play(frames).find((e) => e.type === "pinchend")).toMatchObject({ flick: false });
  });

  it("rides out a dropped frame, and releases a hand gone for longer (never a flick)", () => {
    const g = new GestureRecognizer();
    const pinched = [hand("Left", 0.5, 0.5, 0.2)];
    play([pinched, pinched], g);
    expect(types(play([[]], g, 2))).toEqual([]);
    expect(g.pinching("Left")).toBe(true);
    expect(types(play([pinched], g, 3))).toEqual([]);
    const gone = Math.ceil(LOST_MS / FRAME_MS) + 1;
    const events = play(
      Array.from({ length: gone }, () => []),
      g,
      4,
    );
    expect(events.filter((e) => e.type !== "pinchmove")).toMatchObject([{ type: "pinchend", flick: false }]);
    expect(g.pinching("Left")).toBe(false);
  });

  it("scales by the ratio of the distance between two pinch points", () => {
    const g = new GestureRecognizer();
    const nl = jitter(4);
    const nr = jitter(5);
    // Both pinch 0.2 of the camera apart (≈ 286 px), then spread to 0.3 apart (≈ 429 px): × 1.5.
    const frames: HandSample[][] = [];
    for (let i = 0; i < 4; i++)
      frames.push([hand("Left", 0.6, 0.5, 0.2, nl), hand("Right", 0.4, 0.5, 0.2, nr)]);
    for (let i = 1; i <= 10; i++) {
      const half = 0.1 + (0.05 * i) / 10;
      frames.push([hand("Left", 0.5 + half, 0.5, 0.2, nl), hand("Right", 0.5 - half, 0.5, 0.2, nr)]);
    }
    for (let i = 0; i < 25; i++) frames.push(frames.at(-1)!);
    const events = play(frames, g);
    expect(types(events).slice(0, 3)).toEqual(["pinchstart", "pinchstart", "scalestart"]);
    const start = events.find((e) => e.type === "scalestart")!;
    if (start.type !== "scalestart") throw new Error();
    expect(start.hands.sort()).toEqual(["Left", "Right"]);
    expect(start.centre.x).toBeCloseTo(500, -1);
    const last = events.filter((e) => e.type === "scale").at(-1)!;
    if (last.type !== "scale") throw new Error();
    expect(last.ratio).toBeCloseTo(1.5, 1);

    // Letting go with one hand ends the scale first; neither release is a flick, however fast.
    const end = play(
      [
        [hand("Left", 0.95, 0.5, 0.9, nl), hand("Right", 0.35, 0.5, 0.2, nr)],
        [hand("Right", 0.35, 0.5, 0.9, nr)],
      ],
      g,
      frames.length,
    );
    expect(types(end)).toEqual(["scaleend", "pinchend", "pinchend"]);
    expect(end.filter((e) => e.type === "pinchend").every((e) => e.type === "pinchend" && !e.flick)).toBe(
      true,
    );
  });

  it("lets go of everything when cleared", () => {
    const g = new GestureRecognizer();
    play([[hand("Left", 0.6, 0.5, 0.2), hand("Right", 0.4, 0.5, 0.2)]], g);
    expect(types(g.clear())).toEqual(["scaleend", "pinchend", "pinchend"]);
    expect(g.pinching("Left")).toBe(false);
  });
});

describe("releaseVelocity", () => {
  it("measures the last 100 ms of the trail", () => {
    const trail = [0, 50, 100, 150].map((t) => ({ t, p: { x: t * (t > 50 ? 3 : 1), y: 0 } }));
    // From t=50 (x=50) to t=150 (x=450): 4000 px/s.
    expect(releaseVelocity(trail)).toEqual({ x: 4000, y: 0 });
    expect(releaseVelocity([{ t: 0, p: { x: 1, y: 1 } }])).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([])).toEqual({ x: 0, y: 0 });
  });
});

describe("scaleRect", () => {
  const rect = { x: 100, y: 100, width: 600, height: 400 };
  const min = { width: 420, height: 320 };

  it("scales around the centre", () => {
    expect(scaleRect(rect, 1.5, min)).toEqual({ x: -50, y: 0, width: 900, height: 600 });
    expect(scaleRect(rect, 0.9, min)).toEqual({ x: 130, y: 120, width: 540, height: 360 });
  });

  it("never goes below the feature's min size", () => {
    for (const ratio of [0.75, 0.5, 0.1, 0.0001, 0, -2, Number.NaN]) {
      const r = scaleRect(rect, ratio, min);
      expect(r.width).toBeGreaterThanOrEqual(min.width);
      expect(r.height).toBeGreaterThanOrEqual(min.height);
    }
    // Still centred where it was.
    const r = scaleRect(rect, 0.1, min);
    expect(r.x + r.width / 2).toBe(400);
    expect(r.y + r.height / 2).toBe(300);
  });
});

import { describe, expect, it } from "vitest";
import { FADE_AFTER_MS, HandPointers } from "./pointers";

const SCREEN = { width: 1000, height: 800 };
const centre = { hand: "Left", index: { x: 0.5, y: 0.5 }, thumb: { x: 0.5, y: 0.5 } };

describe("HandPointers", () => {
  it("puts each hand's fingertips on screen, mirrored", () => {
    const p = new HandPointers();
    const [left, right] = p.update(
      [centre, { hand: "Right", index: { x: 0.15, y: 0.15 }, thumb: { x: 0.85, y: 0.85 } }],
      0,
      SCREEN,
    );
    expect(left).toEqual({
      hand: "Left",
      index: { x: 500, y: 400 },
      thumb: { x: 500, y: 400 },
      visible: true,
    });
    expect(right.index).toEqual({ x: 1000, y: 0 });
    expect(right.thumb.x).toBeCloseTo(0, 6);
    expect(right.thumb.y).toBeCloseTo(800, 6);
  });

  it(`fades a hand ${FADE_AFTER_MS} ms after it was last seen`, () => {
    const p = new HandPointers();
    p.update([centre], 0, SCREEN);
    expect(p.update([], FADE_AFTER_MS - 1, SCREEN)[0].visible).toBe(true);
    const [faded] = p.update([], FADE_AFTER_MS, SCREEN);
    // Stays where it was while it fades.
    expect(faded).toMatchObject({ visible: false, index: { x: 500, y: 400 } });
  });

  it("starts smoothing afresh when a faded hand comes back", () => {
    const p = new HandPointers();
    p.update([centre], 0, SCREEN);
    p.update([], 1000, SCREEN);
    const back = { hand: "Left", index: { x: 0.85, y: 0.15 }, thumb: { x: 0.85, y: 0.15 } };
    // Straight to where it is now, not gliding from the centre.
    expect(p.update([back], 1033, SCREEN)[0].index).toEqual({ x: 0, y: 0 });
  });

  it("forgets every hand when cleared", () => {
    const p = new HandPointers();
    p.update([centre], 0, SCREEN);
    p.clear();
    expect(p.tick(10)).toEqual([]);
  });
});

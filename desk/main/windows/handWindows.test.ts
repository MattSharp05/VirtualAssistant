import { describe, expect, it } from "vitest";
import { isRect, screenBounds, TITLE_BAR_HEIGHT, windowAt, type StackedWindow } from "./handWindows";

const min = { width: 420, height: 320 };
// Front to back: chat overlaps today's title bar.
const stack: StackedWindow[] = [
  { id: "chat", bounds: { x: 300, y: 200, width: 500, height: 600 }, minSize: min },
  { id: "today", bounds: { x: 100, y: 180, width: 800, height: 500 }, minSize: { width: 560, height: 400 } },
];
// The overlay sits under the menu bar.
const overlay = { x: 0, y: 25 };

describe("windowAt", () => {
  it("finds the frontmost window whose title bar is under the point, in the overlay's coordinates", () => {
    expect(windowAt(stack, { x: 150, y: 160 }, "titlebar", overlay)).toEqual({
      id: "today",
      bounds: { x: 100, y: 155, width: 800, height: 500 },
      minSize: { width: 560, height: 400 },
    });
    // Where chat's title bar covers today's, chat wins.
    expect(windowAt(stack, { x: 350, y: 180 }, "titlebar", overlay)?.id).toBe("chat");
    // Below the title bar, or off every window: nothing to grab.
    expect(windowAt(stack, { x: 150, y: 155 + TITLE_BAR_HEIGHT + 1 }, "titlebar", overlay)).toBeUndefined();
    expect(windowAt(stack, { x: 20, y: 20 }, "titlebar", overlay)).toBeUndefined();
  });

  it("finds any part of a window for a two-hand resize", () => {
    expect(windowAt(stack, { x: 150, y: 500 }, "any", overlay)?.id).toBe("today");
    expect(windowAt(stack, { x: 400, y: 500 }, "any", overlay)?.id).toBe("chat");
    expect(windowAt([], { x: 400, y: 500 }, "any", overlay)).toBeUndefined();
  });
});

describe("screenBounds", () => {
  it("turns overlay bounds into whole screen pixels, never below the min size", () => {
    expect(screenBounds({ x: 10.4, y: 20.6, width: 600, height: 400 }, overlay, min)).toEqual({
      x: 10,
      y: 46,
      width: 600,
      height: 400,
    });
    expect(screenBounds({ x: 0, y: 0, width: 100, height: 50 }, overlay, min)).toMatchObject(min);
  });
});

describe("isRect", () => {
  it("accepts only finite numbers and a positive size", () => {
    expect(isRect({ x: 0, y: -5, width: 1, height: 1 })).toBe(true);
    expect(isRect({ x: 0, y: 0, width: 0, height: 1 })).toBe(false);
    expect(isRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toBe(false);
    expect(isRect({ x: "1", y: 0, width: 1, height: 1 })).toBe(false);
    expect(isRect(null)).toBe(false);
  });
});

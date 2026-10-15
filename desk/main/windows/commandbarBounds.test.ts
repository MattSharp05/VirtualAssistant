import { describe, expect, it } from "vitest";
import { commandBarBounds } from "./commandbarBounds";

describe("command bar bounds", () => {
  it("centres the bar a fifth of the way down the display", () => {
    expect(commandBarBounds({ width: 680, height: 480 }, { x: 0, y: 25, width: 1440, height: 875 })).toEqual({
      x: 380,
      y: 200,
      width: 680,
      height: 480,
    });
  });

  it("works on a second display left of the primary, and shrinks to fit a small one", () => {
    expect(
      commandBarBounds({ width: 680, height: 480 }, { x: -1280, y: 0, width: 1280, height: 800 }),
    ).toEqual({
      x: -980,
      y: 160,
      width: 680,
      height: 480,
    });
    expect(commandBarBounds({ width: 680, height: 480 }, { x: 0, y: 0, width: 600, height: 400 })).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });
  });
});

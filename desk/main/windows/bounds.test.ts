import { describe, expect, it } from "vitest";
import { centred, restoreBounds } from "./bounds";

const primary = { x: 0, y: 25, width: 1440, height: 875 };
const external = { x: 1440, y: 0, width: 2560, height: 1440 };

describe("restoreBounds", () => {
  it("keeps bounds that are still on a connected display", () => {
    const onExternal = { x: 2000, y: 300, width: 700, height: 500 };
    expect(restoreBounds(onExternal, [primary, external], primary)).toEqual(onExternal);
    const onPrimary = { x: 100, y: 100, width: 700, height: 500 };
    expect(restoreBounds(onPrimary, [primary], primary)).toEqual(onPrimary);
  });

  it("brings a window from a disconnected display back onto the primary display", () => {
    const wasOnExternal = { x: 2000, y: 300, width: 700, height: 500 };
    const restored = restoreBounds(wasOnExternal, [primary], primary);
    expect(restored).toEqual({ x: 370, y: 213, width: 700, height: 500 });
  });

  it("rescues a window whose title bar is off screen, and shrinks one too big to fit", () => {
    const titleAbove = { x: 100, y: -400, width: 700, height: 500 };
    expect(restoreBounds(titleAbove, [primary], primary).y).toBeGreaterThanOrEqual(primary.y);
    const huge = { x: 5000, y: 0, width: 3000, height: 2000 };
    expect(restoreBounds(huge, [primary], primary)).toEqual(primary);
  });
});

describe("centred", () => {
  it("centres a size in an area", () => {
    expect(centred({ width: 400, height: 300 }, { x: 0, y: 0, width: 1000, height: 1000 })).toEqual({
      x: 300,
      y: 350,
      width: 400,
      height: 300,
    });
  });
});

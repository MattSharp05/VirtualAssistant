// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inside, orbZone, OverlayMouse } from "./dropZone";

describe("drop zone", () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };

  it("is the square around the corner orb", () => {
    const zone = orbZone(workArea);
    // The orb's centre: 28 px in from the right and top, 28 px across.
    const centre = { x: 1440 - 28 - 14, y: 25 + 28 + 14 };
    expect(inside(centre, zone)).toBe(true);
    expect(inside({ x: centre.x + 30, y: centre.y - 30 }, zone)).toBe(true);
    expect(inside({ x: centre.x - 60, y: centre.y }, zone)).toBe(false);
    expect(inside({ x: centre.x, y: centre.y + 60 }, zone)).toBe(false);
    expect(inside({ x: 700, y: 400 }, zone)).toBe(false);
  });

  it("takes the mouse while the renderer asks or the pointer is on the orb, reporting changes only", () => {
    const seen: boolean[] = [];
    const mouse = new OverlayMouse((on) => seen.push(on));
    mouse.setNear(false);
    mouse.setNear(true);
    mouse.setHit(true);
    mouse.setNear(false);
    mouse.setHit(false);
    mouse.setHit(false);
    expect(seen).toEqual([false, true, false]);
  });
});

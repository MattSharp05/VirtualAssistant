import { describe, expect, it } from "vitest";
import { HitRegions } from "./hitRegions";

describe("HitRegions", () => {
  it("turns click-through off only while the pointer is over an interactive region", () => {
    const reports: boolean[] = [];
    const hits = new HitRegions((on) => reports.push(on));
    expect(hits.interactive).toBe(false);
    hits.enter("orb");
    expect(hits.interactive).toBe(true);
    hits.enter("card"); // already interactive: no second report
    hits.leave("orb");
    expect(hits.interactive).toBe(true);
    hits.leave("card");
    hits.leave("card"); // leaving twice doesn't report again
    expect(hits.interactive).toBe(false);
    expect(reports).toEqual([true, false]);
  });
});

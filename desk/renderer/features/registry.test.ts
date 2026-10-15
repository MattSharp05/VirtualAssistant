import { describe, expect, it } from "vitest";
import { features, findFeature } from "./registry";

describe("feature registry", () => {
  it("discovers every feature folder with its metadata and component", () => {
    const ids = features.map((f) => f.id);
    expect(ids).toContain("overlay");
    expect(ids).toContain("hello");
    for (const f of features) {
      expect(f.title, f.id).toBeTruthy();
      expect(f.icon, f.id).toBeTruthy();
      expect(typeof f.component, f.id).toBe("function");
    }
    expect(findFeature("hello")?.minSize).toEqual({ width: 320, height: 220 });
    expect(findFeature("overlay")?.framed).toBe(false);
  });
});

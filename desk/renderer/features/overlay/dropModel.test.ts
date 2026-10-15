import { describe, expect, it } from "vitest";
import { askText, dropReducer, initialDrop, summariseText, type DropState } from "./dropModel";

const upload = { id: "u1", path: "/data/jarvis/uploads/u1/q3.pdf", name: "q3.pdf" };

describe("file drop on the orb (JD-40)", () => {
  it("shows the ring while dragging, then progress, then the question", () => {
    let s: DropState = dropReducer(initialDrop, { type: "drag", on: true });
    expect(s.dragging).toBe(true);
    expect(dropReducer(s, { type: "drag", on: true })).toBe(s);
    s = dropReducer(s, { type: "dropped", seq: 1, name: "q3.pdf" });
    expect(s).toEqual({ dragging: false, seq: 1, card: { kind: "uploading", name: "q3.pdf", progress: 0 } });
    s = dropReducer(s, { type: "progress", seq: 1, progress: 0.5 });
    expect(s.card).toEqual({ kind: "uploading", name: "q3.pdf", progress: 0.5 });
    s = dropReducer(s, { type: "progress", seq: 1, progress: 7 });
    expect(s.card).toMatchObject({ progress: 1 });
    s = dropReducer(s, { type: "uploaded", seq: 1, upload });
    expect(s.card).toEqual({ kind: "ready", upload });
    expect(dropReducer(s, { type: "dismiss" }).card).toBeUndefined();
  });

  it("a newer drop wins over a slower older upload", () => {
    let s = dropReducer(initialDrop, { type: "dropped", seq: 1, name: "a.pdf" });
    s = dropReducer(s, { type: "dropped", seq: 2, name: "b.pdf" });
    expect(dropReducer(s, { type: "uploaded", seq: 1, upload })).toBe(s);
    expect(dropReducer(s, { type: "progress", seq: 1, progress: 0.9 })).toBe(s);
    expect(dropReducer(s, { type: "rejected", seq: 1, message: "late" })).toBe(s);
    s = dropReducer(s, { type: "rejected", seq: 2, message: "Couldn't upload b.pdf: offline" });
    expect(s.card).toEqual({ kind: "rejected", message: "Couldn't upload b.pdf: offline" });
    s = dropReducer(s, { type: "rejected", seq: 3, message: "big.pdf is 25 MB: files can be up to 20 MB." });
    expect(s).toMatchObject({ seq: 3, card: { kind: "rejected" } });
  });

  it("words what Summarise and Ask send", () => {
    expect(summariseText("q3.pdf")).toBe("Summarise q3.pdf.");
    expect(askText("q3.pdf")).toBe("About q3.pdf: ");
  });
});

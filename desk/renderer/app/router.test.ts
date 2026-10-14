import { describe, expect, it } from "vitest";
import { windowIdFromHash, windowIdFromLocation } from "./router";

describe("windowIdFromHash", () => {
  it("reads the window id from the hash", () => {
    expect(windowIdFromHash("#/chat")).toBe("chat");
    expect(windowIdFromHash("#/sessions/cse_1")).toBe("sessions");
    expect(windowIdFromHash("#/today?section=inbox")).toBe("today");
  });

  it("falls back to home", () => {
    expect(windowIdFromHash("")).toBe("home");
    expect(windowIdFromHash("#/")).toBe("home");
  });
});

describe("windowIdFromLocation", () => {
  it("prefers ?window= over the hash", () => {
    expect(windowIdFromLocation({ search: "?scenario=demo-day&window=chat", hash: "#/home" })).toBe("chat");
    expect(windowIdFromLocation({ search: "?scenario=demo-day", hash: "#/today" })).toBe("today");
  });
});

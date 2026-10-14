import { describe, expect, it } from "vitest";
import { windowIdFromHash } from "./router";

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

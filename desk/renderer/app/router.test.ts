import { describe, expect, it } from "vitest";
import { windowHash, windowIdFromHash, windowIdFromLocation, windowParams } from "./router";

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

describe("window params (JD-32)", () => {
  it("builds the hash main opens a window with", () => {
    expect(windowHash("sessions")).toBe("/sessions");
    expect(windowHash("sessions", { id: "mk" })).toBe("/sessions?id=mk");
    expect(windowHash("sessions", { id: 3 } as unknown as Record<string, string>)).toBe("/sessions");
  });

  it("reads params from the hash, falling back to the page query", () => {
    expect(windowParams({ search: "", hash: "#/sessions?id=mk" }).get("id")).toBe("mk");
    expect(windowParams({ search: "?scenario=sessions&window=sessions&id=trip", hash: "" }).get("id")).toBe(
      "trip",
    );
    expect(windowParams({ search: "?id=trip", hash: "#/sessions?id=mk" }).get("id")).toBe("mk");
    expect(windowIdFromHash(`#${windowHash("sessions", { id: "mk" })}`)).toBe("sessions");
  });
});

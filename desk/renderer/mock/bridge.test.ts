import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent } from "@jarvis/shared";
import { createMockBridge, PENDING } from "./bridge";
import { findScenario, scenarios } from "./scenarios";
import type { Scenario } from "./types";

const notice = (title: string): DeskEvent => ({
  type: "notice",
  at: "2026-10-14T09:00:00Z",
  level: "info",
  title,
});

describe("mock bridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("replays a scenario's events in order, each after its delay", () => {
    const scenario: Scenario = {
      name: "t",
      description: "",
      data: {},
      events: [
        { after: 100, event: notice("one") },
        { after: 0, event: notice("two") },
        { after: 400, event: notice("three") },
      ],
    };
    const bridge = createMockBridge(scenario);
    const seen: string[] = [];
    bridge.subscribe((e) => e.type === "notice" && seen.push(e.title));
    vi.advanceTimersByTime(99);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["one", "two"]);
    vi.advanceTimersByTime(399);
    expect(seen).toEqual(["one", "two"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["one", "two", "three"]);
    bridge.close();
  });

  it("answers requests from scenario data and refuses unknown paths", async () => {
    const bridge = createMockBridge(findScenario("demo-day")!);
    const sessions = await bridge.request<{ id: string }[]>("/sessions");
    expect(sessions.map((s) => s.id)).toEqual([
      "mk",
      "trip",
      "mk-80-builder",
      "session_01SM",
      "virtual-assistant",
      "notes-cleanup",
    ]);
    await expect(bridge.request("/nope")).rejects.toThrow(/No mock data for \/nope/);
    bridge.close();
  });

  it("logs every request with its body", async () => {
    const bridge = createMockBridge(findScenario("demo-day")!);
    await bridge.request("/today");
    await bridge.request("/today/refresh", {});
    expect(bridge.requests).toEqual([{ path: "/today" }, { path: "/today/refresh", body: {} }]);
    bridge.close();
  });

  it("opens a window id with options as query parameters", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bridge = createMockBridge(findScenario("demo-day")!);
    bridge.openWindow("today?section=inbox");
    expect(bridge.opened).toEqual(["today?section=inbox"]);
    const url = new URL(String(open.mock.calls[0][0]));
    expect(url.searchParams.get("window")).toBe("today");
    expect(url.searchParams.get("section")).toBe("inbox");
    open.mockRestore();
    bridge.close();
  });

  it("answers a path with a query from the route's data, unless the exact path has its own", async () => {
    const bridge = createMockBridge({
      name: "t",
      description: "",
      data: { "/calendar": "any range", "/calendar?start=2026-10-12": "that week", "/slow": PENDING },
      events: [],
    });
    expect(await bridge.request("/calendar?start=2026-10-19&end=2026-10-25")).toBe("any range");
    expect(await bridge.request("/calendar?start=2026-10-12")).toBe("that week");
    // PENDING never answers (loading states).
    const slow = bridge.request("/slow").then(() => "answered");
    expect(await Promise.race([slow, Promise.resolve("pending")])).toBe("pending");
    bridge.close();
  });

  it("streams a canned chat reply as brain.* events", async () => {
    const bridge = createMockBridge({
      name: "t",
      description: "",
      data: {},
      events: [],
      chatReply: "Hi there Matthew.",
    });
    const seen: DeskEvent[] = [];
    bridge.subscribe((e) => seen.push(e));
    const { messageId } = await bridge.chat("hello", "desk-voice");
    vi.runAllTimers();
    expect(seen.map((e) => e.type)).toEqual([
      "brain.start",
      "orb.state",
      "brain.delta",
      "brain.delta",
      "brain.delta",
      "brain.done",
      "orb.state",
    ]);
    const text = seen
      .flatMap((e) => (e.type === "brain.delta" && e.messageId === messageId ? [e.text] : []))
      .join("");
    expect(text).toBe("Hi there Matthew.");
  });
});

describe("scenarios", () => {
  it("are discovered from the folder, starting with empty and demo-day", () => {
    expect(scenarios.map((s) => s.name)).toEqual(expect.arrayContaining(["empty", "demo-day"]));
  });

  it("demo-day is composed from every mock/data file", () => {
    const demo = findScenario("demo-day")!;
    expect(Object.keys(demo.data)).toEqual(
      expect.arrayContaining(["/calendar/today", "/inbox", "/sessions", "/tasks", "/today"]),
    );
    expect(demo.events.length).toBeGreaterThan(0);
  });
});

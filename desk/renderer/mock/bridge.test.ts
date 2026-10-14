import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent } from "@jarvis/shared";
import { createMockBridge } from "./bridge";
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
    expect(sessions.map((s) => s.id)).toEqual(["mk", "trip", "shapemint"]);
    await expect(bridge.request("/nope")).rejects.toThrow(/No mock data for \/nope/);
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
    expect(Object.keys(demo.data).sort()).toEqual(["/calendar/today", "/inbox", "/sessions", "/tasks"]);
    expect(demo.events.length).toBeGreaterThan(0);
  });
});

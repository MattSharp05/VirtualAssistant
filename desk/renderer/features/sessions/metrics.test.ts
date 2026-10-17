import { describe, expect, it } from "vitest";
import type { DeskSession, SessionMetrics } from "@jarvis/shared";
import {
  contextTone,
  formatCost,
  formatCount,
  formatDuration,
  formatTokens,
  prLabel,
  sortSessions,
} from "./metrics";

describe("session metric formats", () => {
  it("tokens: plain under 1k, then k / M / B with one decimal under 10", () => {
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(6_812)).toBe("6.8 k");
    expect(formatTokens(96_455)).toBe("96 k");
    expect(formatTokens(1_204_000)).toBe("1.2 M");
    expect(formatTokens(831_607_089)).toBe("832 M");
    expect(formatTokens(1_000_000)).toBe("1 M");
    expect(formatTokens(3_953_507_630)).toBe("4 B");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(undefined)).toBeUndefined();
  });

  it("cost: cents under $1,000, whole dollars above, and a floor for fractions of a cent", () => {
    expect(formatCost(269.76)).toBe("$269.76");
    expect(formatCost(6.4)).toBe("$6.40");
    expect(formatCost(1284.52)).toBe("$1,285");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(undefined)).toBeUndefined();
  });

  it("durations, long and short", () => {
    const min = 60_000;
    expect(formatDuration(20_000)).toBe("<1m");
    expect(formatDuration(47 * min)).toBe("47m");
    expect(formatDuration(185 * min)).toBe("3h 5m");
    expect(formatDuration(185 * min, true)).toBe("3h");
    expect(formatDuration(120 * min)).toBe("2h");
    expect(formatDuration(27 * 60 * min)).toBe("1d 3h");
    expect(formatDuration(27 * 60 * min, true)).toBe("1d");
    expect(formatDuration(undefined)).toBeUndefined();
  });

  it("the context bar turns amber at 70% and red at 85%", () => {
    expect(contextTone(69.9)).toBe("ok");
    expect(contextTone(70)).toBe("amber");
    expect(contextTone(84.9)).toBe("amber");
    expect(contextTone(85)).toBe("red");
    expect(contextTone(100)).toBe("red");
  });

  it("counts mark a lower bound; PR links read as repo #n", () => {
    expect(formatCount(2410)).toBe("2,410");
    expect(formatCount(612, true)).toBe("612+");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(undefined, true)).toBeUndefined();
    expect(prLabel("https://github.com/MattSharp05/MarioKart/pull/79")).toBe("MarioKart #79");
    expect(prLabel("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("sortSessions", () => {
  const s = (id: string, metrics?: Partial<SessionMetrics>): DeskSession => ({
    id,
    sessionId: id,
    title: id,
    group: "idle",
    url: "",
    metrics: metrics && { checkedAt: "2026-10-17T00:00:00Z", ...metrics },
  });
  const list = [
    s("cheap", { costUsd: 2, contextPercent: 90 }),
    s("unknown", {}),
    s("dear", { costUsd: 270, contextPercent: 27 }),
    s("none"),
    s("mid", { costUsd: 33.9, contextPercent: 88 }),
    s("free", { costUsd: 0, contextPercent: 0 }),
  ];
  const ids = (l: DeskSession[]) => l.map((x) => x.id);

  it("Most expensive: biggest cost first, unknown cost last (0 is known)", () => {
    expect(ids(sortSessions(list, "cost"))).toEqual(["dear", "mid", "cheap", "free", "unknown", "none"]);
  });

  it("Context fullest: biggest percent first, unknown last, ties keep their order", () => {
    expect(ids(sortSessions(list, "context"))).toEqual(["cheap", "mid", "dear", "free", "unknown", "none"]);
    const tie = [s("a", { contextPercent: 50 }), s("b", { contextPercent: 50 })];
    expect(ids(sortSessions(tie, "context"))).toEqual(["a", "b"]);
  });

  it("doesn't change the list it was given", () => {
    const copy = [...list];
    sortSessions(list, "cost");
    expect(list).toEqual(copy);
  });
});

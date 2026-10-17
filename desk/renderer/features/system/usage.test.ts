import { describe, expect, it } from "vitest";
import type { ProjectUsage, UsageDay } from "@jarvis/shared";
import {
  chartSeries,
  dayLabel,
  dayLong,
  money,
  moneyAxis,
  nextSort,
  niceScale,
  sortProjects,
  stackDays,
} from "./usage";

const period = (costUsd: number, tokens: number, sessions = 1) => ({
  costUsd,
  tokens,
  sessions,
  wallMs: sessions * 1000,
  activeMs: 0,
});
const project = (name: string, week: number, all: number, active = 0): ProjectUsage => ({
  project: name,
  activeSessions: active,
  week: period(week, week * 1000),
  allTime: period(all, all * 1000, Math.round(all)),
});

describe("money", () => {
  it("shows cents under $1,000 and whole dollars above", () => {
    expect(money(0)).toBe("$0");
    expect(money(0.004)).toBe("<$0.01");
    expect(money(0.42)).toBe("$0.42");
    expect(money(12.4)).toBe("$12.40");
    expect(money(1240.6)).toBe("$1,241");
    expect(moneyAxis(50)).toBe("$50");
    expect(moneyAxis(2500)).toBe("$2,500");
    expect(moneyAxis(0.5)).toBe("$0.50");
  });
});

describe("sortProjects", () => {
  const list = [project("b", 5, 50, 1), project("A", 9, 20), project("c", 5, 70, 2)];
  it("sorts by the chosen column and period, ties in the server's order", () => {
    expect(sortProjects(list, "week", { key: "cost", dir: "desc" }).map((p) => p.project)).toEqual([
      "A",
      "b",
      "c",
    ]);
    expect(sortProjects(list, "allTime", { key: "cost", dir: "desc" }).map((p) => p.project)).toEqual([
      "c",
      "b",
      "A",
    ]);
    expect(sortProjects(list, "week", { key: "project", dir: "asc" }).map((p) => p.project)).toEqual([
      "A",
      "b",
      "c",
    ]);
    expect(sortProjects(list, "week", { key: "active", dir: "asc" }).map((p) => p.project)).toEqual([
      "A",
      "b",
      "c",
    ]);
  });
  it("flips the same column and starts a new one high to low (names A–Z)", () => {
    expect(nextSort({ key: "cost", dir: "desc" }, "cost")).toEqual({ key: "cost", dir: "asc" });
    expect(nextSort({ key: "cost", dir: "asc" }, "tokens")).toEqual({ key: "tokens", dir: "desc" });
    expect(nextSort({ key: "cost", dir: "desc" }, "project")).toEqual({ key: "project", dir: "asc" });
  });
});

describe("chart series", () => {
  const projects = ["p1", "Other", "p2", "p3", "p4", "p5", "p6"].map((n, i) => project(n, 1, 100 - i));
  const day = (projects: UsageDay["projects"]): UsageDay => ({
    day: "2026-10-14",
    costUsd: Object.values(projects).reduce((n, u) => n + u.costUsd, 0),
    tokens: Object.values(projects).reduce((n, u) => n + u.tokens, 0),
    projects,
  });

  it("colours the first five projects in the list's order and folds the rest into Other", () => {
    expect(chartSeries(projects, [])).toEqual([
      { key: "p1", slot: 1 },
      { key: "p2", slot: 2 },
      { key: "p3", slot: 3 },
      { key: "p4", slot: 4 },
      { key: "p5", slot: 5 },
      { key: "Other", slot: "other" },
    ]);
    expect(chartSeries(projects.slice(2, 4), [])).toEqual([
      { key: "p2", slot: 1 },
      { key: "p3", slot: 2 },
    ]);
  });

  it("stacks each day in series order, summing folded projects into Other", () => {
    const series = chartSeries(projects, []);
    const history = [
      day({
        p6: { costUsd: 1, tokens: 10 },
        p2: { costUsd: 2, tokens: 20 },
        Other: { costUsd: 0.5, tokens: 5 },
        p1: { costUsd: 3, tokens: 30 },
      }),
      day({}),
    ];
    const [first, empty] = stackDays(history, series, "cost");
    expect(first.total).toBe(6.5);
    expect(first.segments).toEqual([
      { key: "p1", value: 3 },
      { key: "p2", value: 2 },
      { key: "Other", value: 1.5 },
    ]);
    expect(empty).toEqual({ day: "2026-10-14", total: 0, segments: [] });
    expect(stackDays(history, series, "tokens")[0].segments.map((s) => s.value)).toEqual([30, 20, 15]);
  });

  it("rounds the axis up to 1, 2 or 5 × 10ⁿ", () => {
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 0.5, 1] });
    expect(niceScale(37.2)).toEqual({ top: 50, ticks: [0, 25, 50] });
    expect(niceScale(12)).toEqual({ top: 20, ticks: [0, 10, 20] });
    expect(niceScale(2_400_000).top).toBe(5_000_000);
    expect(niceScale(100).top).toBe(100);
  });

  it("labels days by the server's calendar day", () => {
    expect(dayLabel("2026-10-14")).toBe("14 Oct");
    expect(dayLong("2026-10-14")).toBe("Wed 14 Oct");
  });
});

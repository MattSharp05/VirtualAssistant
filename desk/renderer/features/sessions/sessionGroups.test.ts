import { describe, expect, it } from "vitest";
import type { DeskSession } from "@jarvis/shared";
import {
  ago,
  clock,
  groupByProject,
  groupSessions,
  labelOf,
  matches,
  pillOf,
  statusSummary,
  toneOf,
  whoOf,
} from "./sessionGroups";

const session = (over: Partial<DeskSession>): DeskSession => ({
  id: "x",
  sessionId: "session_x",
  title: "Something",
  group: "idle",
  url: "https://claude.ai/code/session_x",
  ...over,
});

describe("sessionGroups", () => {
  const list = [
    session({
      id: "mk",
      name: "mk",
      group: "needs-you",
      latestKind: "blocked",
      latestReport: "⛔ MK-81 blocked",
    }),
    session({ id: "notes", name: "notes", group: "idle", title: "Tidy Notion" }),
    session({ id: "sm", group: "working", title: "ShapeMint export" }),
  ];

  it("groups in order NEEDS YOU, WORKING, IDLE and drops empty groups", () => {
    expect(groupSessions(list).map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ["Needs you", ["mk"]],
      ["Working", ["sm"]],
      ["Idle", ["notes"]],
    ]);
    expect(groupSessions([list[0]]).map((g) => g.id)).toEqual(["needs-you"]);
  });

  it("filters by name, title or latest report", () => {
    expect(groupSessions(list, "shape").flatMap((g) => g.sessions.map((s) => s.id))).toEqual(["sm"]);
    expect(matches(list[0], "MK-81")).toBe(true);
    expect(matches(list[1], "  ")).toBe(true);
    expect(groupSessions(list, "nothing")).toEqual([]);
  });

  it("by project: one group per project in first-seen order, needs-you rows first, No project last", () => {
    const sessions = [
      session({ id: "scratch", group: "needs-you" }),
      session({ id: "batch", project: "JARVIS Desk", group: "working" }),
      session({ id: "mk", project: "MarioKart", group: "needs-you", latestKind: "blocked" }),
      session({ id: "design", project: "JARVIS Desk", group: "needs-you" }),
      session({ id: "builder", project: "MarioKart", group: "idle" }),
      session({ id: "jd-62", project: "JARVIS Desk", group: "working" }),
      session({ id: "blank", project: "  ", group: "idle" }),
    ];
    expect(groupByProject(sessions).map((g) => [g.label, g.summary, g.sessions.map((s) => s.id)])).toEqual([
      ["JARVIS Desk", "1 needs you · 2 working", ["design", "batch", "jd-62"]],
      ["MarioKart", "1 needs you · 1 idle", ["mk", "builder"]],
      ["No project", "1 needs you · 1 idle", ["scratch", "blank"]],
    ]);
  });

  it("by project: filters (also by project name) and drops projects left empty", () => {
    const sessions = [
      session({ id: "mk", name: "mk", project: "MarioKart" }),
      session({ id: "trip", name: "trip", project: "TripPlanner" }),
    ];
    expect(groupByProject(sessions, "trip").map((g) => g.label)).toEqual(["TripPlanner"]);
    expect(groupByProject(sessions, "mario").map((g) => g.sessions.map((s) => s.id))).toEqual([["mk"]]);
    expect(groupByProject(sessions, "nothing")).toEqual([]);
    expect(groupByProject([])).toEqual([]);
  });

  it("status summary counts only the statuses present", () => {
    expect(statusSummary([{ group: "idle" }, { group: "working" }, { group: "idle" }])).toBe(
      "1 working · 2 idle",
    );
    expect(statusSummary([])).toBe("");
  });

  it("dot colour and pill follow the group and what the latest report said", () => {
    expect([toneOf(list[0]), pillOf(list[0])]).toEqual(["red", "Blocked · needs you"]);
    const qa = { group: "needs-you", latestKind: "finished" } as const;
    expect([toneOf(qa), pillOf(qa)]).toEqual(["amber", "Ready for QA"]);
    expect(pillOf({ group: "needs-you", latestKind: "decision" })).toBe("Needs a decision");
    expect([toneOf(list[2]), pillOf(list[2])]).toEqual(["green", "Working"]);
    expect([toneOf(list[1]), pillOf(list[1])]).toEqual(["grey", "Idle"]);
  });

  it("labels: the tracked name, else the title", () => {
    expect(labelOf(list[0])).toBe("mk");
    expect(labelOf(list[2])).toBe("ShapeMint export");
  });

  it("short times", () => {
    const now = Date.parse("2026-10-14T09:00:00Z");
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    expect([
      ago(at(0), now),
      ago(at(12), now),
      ago(at(130), now),
      ago(at(3 * 24 * 60), now),
      ago(undefined, now),
    ]).toEqual(["now", "12m", "2h", "3d", ""]);
    const d = new Date(2026, 9, 14, 8, 5);
    expect(clock(d.toISOString())).toBe("08:05");
  });

  it("who an activity line is from", () => {
    expect(whoOf({ role: "assistant", text: "" }, "mk")).toBe("mk");
    expect(whoOf({ role: "user", text: "" }, "mk")).toBe("you");
    expect(whoOf({ role: "tool", text: "" }, "mk")).toBe("tool");
  });
});

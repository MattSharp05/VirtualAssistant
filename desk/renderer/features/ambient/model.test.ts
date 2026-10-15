import { describe, expect, it } from "vitest";
import type { DeskSession, DigestEvent, TaskItem } from "@jarvis/shared";
import {
  ago,
  clockText,
  dateText,
  lastReport,
  meterTone,
  nextEvent,
  openCount,
  sessionCounts,
  span,
} from "./model";

// Local times, so the checks hold in any time zone.
const at = (h: number, m = 0) => new Date(2026, 9, 14, h, m).getTime();
const iso = (h: number, m = 0) => new Date(at(h, m)).toISOString();
const ev = (from: number, to: number, title: string, location?: string): DigestEvent => ({
  start: iso(from),
  end: iso(to),
  title,
  calendar: "Work",
  ...(location ? { location } : {}),
});
const session = (id: string, extra: Partial<DeskSession>): DeskSession => ({
  id,
  name: id,
  sessionId: `session_${id}`,
  title: id,
  group: "idle",
  url: "https://claude.ai/code",
  ...extra,
});

describe("ambient model", () => {
  it("formats the clock and the date", () => {
    expect(clockText(at(9, 5))).toBe("09:05");
    expect(clockText(at(18))).toBe("18:00");
    expect(dateText(at(9))).toBe("Wednesday 14 October");
  });

  it("finds the event on now, else the next one, else nothing", () => {
    const events = [ev(9, 10, "Standup"), ev(12, 13, "Lunch", "Dishoom")];
    expect(nextEvent(events, at(8, 30))).toEqual({ title: "Standup · 09:00", when: "in 30 min" });
    expect(nextEvent(events, at(9, 20))).toEqual({ title: "Standup · 09:00", when: "now · until 10:00" });
    expect(nextEvent(events, at(10))).toEqual({
      title: "Lunch · 12:00",
      when: "in 2 h",
      location: "Dishoom",
    });
    expect(nextEvent(events, at(13))).toBeUndefined();
  });

  it("spans and ages in words", () => {
    expect(span(150 * 60_000)).toBe("2 h 30 min");
    expect(span(-5)).toBe("0 min");
    expect(ago(iso(9), at(9))).toBe("just now");
    expect(ago(iso(9), at(9, 12))).toBe("12 min ago");
    expect(ago(iso(9), at(12, 30))).toBe("3 h ago");
  });

  it("counts sessions working, waiting on Matthew and blocked", () => {
    const sessions = [
      session("a", { group: "working" }),
      session("b", { group: "working" }),
      session("c", { group: "needs-you", latestKind: "blocked" }),
      session("d", { group: "needs-you", latestKind: "decision" }),
      session("e", { group: "needs-you", latestKind: "finished" }),
      session("f", { group: "idle", latestKind: "blocked" }),
    ];
    expect(sessionCounts(sessions)).toEqual({ working: 2, waiting: 2, blocked: 1 });
    expect(sessionCounts([])).toEqual({ working: 0, waiting: 0, blocked: 0 });
  });

  it("picks the newest report, by name or title", () => {
    const sessions = [
      session("mk", { lastActivity: iso(8, 41), latestReport: "MK-81 blocked\nOptions: …" }),
      session("x", { name: undefined, title: "Refactor", lastActivity: iso(8, 50), latestReport: "Done" }),
      session("quiet", { lastActivity: iso(8, 59) }),
    ];
    expect(lastReport(sessions)).toEqual({ who: "Refactor", at: iso(8, 50), text: "Done" });
    expect(lastReport(sessions.slice(0, 1))).toEqual({ who: "mk", at: iso(8, 41), text: "MK-81 blocked" });
    expect(lastReport([sessions[2]!])).toBeUndefined();
  });

  it("counts open to-dos and colours the meters", () => {
    const task = (id: string, status: TaskItem["status"]): TaskItem => ({
      id,
      name: id,
      status,
      source: "You",
      createdAt: iso(8),
    });
    expect(openCount([task("a", "Open"), task("b", "Done"), task("c", "Open")])).toBe(2);
    expect([0, 79, 80, 94, 95, 100].map(meterTone)).toEqual(["ok", "ok", "high", "high", "full", "full"]);
  });
});

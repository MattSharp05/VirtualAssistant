import { describe, expect, it } from "vitest";
import type { DigestEvent } from "@jarvis/shared";
import {
  ageNow,
  clock,
  digestNow,
  eventMeta,
  isStale,
  nextUpIndex,
  received,
  sectionFrom,
  span,
  STALE_AFTER_S,
} from "./model";

const event = (start: string, end: string, title = "x"): DigestEvent => ({
  start,
  end,
  title,
  calendar: "Work",
});

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("Today model", () => {
  it("reads the section from the preview's query or Electron's hash", () => {
    expect(sectionFrom({ search: "?scenario=today&window=today&section=inbox", hash: "" })).toBe("inbox");
    expect(sectionFrom({ search: "", hash: "#/today?section=slack" })).toBe("slack");
    expect(sectionFrom({ search: "", hash: "#/today" })).toBeUndefined();
    expect(sectionFrom({ search: "?section=calendar", hash: "" })).toBeUndefined();
  });

  it("is stale only after 45 minutes, counting time since the fetch", () => {
    expect(isStale(STALE_AFTER_S)).toBe(false);
    expect(isStale(STALE_AFTER_S + 1)).toBe(true);
    expect(ageNow(600, 1_000, 1_000 + 30 * 60_000)).toBe(600 + 1800);
    expect(isStale(ageNow(600, 0, 40 * 60_000))).toBe(true);
  });

  it("runs the server's clock on from the fetch", () => {
    const now = digestNow("2026-10-14T08:53:00Z", 420, 5_000, 65_000);
    expect(new Date(now).toISOString()).toBe("2026-10-14T09:01:00.000Z");
  });

  it("highlights the event in progress, else the next one; none once the day is over", () => {
    const events = [
      event("2026-10-14T08:30:00Z", "2026-10-14T08:45:00Z"),
      event("2026-10-14T11:30:00Z", "2026-10-14T12:30:00Z"),
      event("2026-10-14T17:00:00Z", "2026-10-14T18:00:00Z"),
    ];
    expect(nextUpIndex(events, Date.parse("2026-10-14T08:00:00Z"))).toBe(0);
    expect(nextUpIndex(events, Date.parse("2026-10-14T09:00:00Z"))).toBe(1);
    expect(nextUpIndex(events, Date.parse("2026-10-14T12:00:00Z"))).toBe(1);
    expect(nextUpIndex(events, Date.parse("2026-10-14T19:00:00Z"))).toBe(-1);
  });

  it("describes events: next up with a countdown, now with its end, others with their length", () => {
    const lunch = { ...event("2026-10-14T11:30:00Z", "2026-10-14T12:30:00Z"), location: "Dishoom" };
    expect(eventMeta(lunch, Date.parse("2026-10-14T09:00:00Z"), true)).toBe(
      "Next up · in 2 h 30 min · Dishoom",
    );
    expect(eventMeta(lunch, Date.parse("2026-10-14T11:40:00Z"), true)).toBe(
      `Now · until ${hhmm("2026-10-14T12:30:00Z")} · Dishoom`,
    );
    expect(eventMeta(lunch, 0, false)).toBe("1 h · Dishoom");
    expect(eventMeta(event("2026-10-14T08:30:00Z", "2026-10-14T08:45:00Z"), 0, false)).toBe("15 min · Work");
  });

  it("formats spans and times", () => {
    expect(span(4 * 60_000)).toBe("4 min");
    expect(span(60 * 60_000)).toBe("1 h");
    expect(span(140 * 60_000)).toBe("2 h 20 min");
    expect(clock("2026-10-14T07:31:00Z")).toBe(hhmm("2026-10-14T07:31:00Z"));
  });

  it("says when mail arrived: a time today, yesterday, or the date", () => {
    const now = new Date(2026, 9, 14, 12, 0).getTime();
    expect(received(new Date(2026, 9, 14, 7, 31).toISOString(), now)).toBe("07:31");
    expect(received(new Date(2026, 9, 13, 18, 0).toISOString(), now)).toBe("yesterday");
    expect(received(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe("Mon 12 Oct");
  });
});

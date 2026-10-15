import { describe, expect, it } from "vitest";
import type { CalendarChange, CalendarEvent } from "@jarvis/shared";
import {
  allDayOn,
  boxOf,
  changeTime,
  describeChange,
  gridHours,
  HOUR_PX,
  latestUndoable,
  layoutDay,
  mergeChanges,
  MIN_EVENT_PX,
  monthWeeks,
  newEventText,
  notionLink,
  nowOffset,
  rangeLabel,
  rangeQuery,
  segmentsOn,
  shift,
  visibleRange,
  ymd,
} from "./calendarMath";

// Local times, so the tests hold in any time zone.
const t = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const timed = (id: string, day: number, from: [number, number], to: [number, number]): CalendarEvent => ({
  id,
  calendarId: "primary",
  start: t(day, ...from),
  end: t(day, ...to),
  allDay: false,
  title: id,
  kind: "work",
});
const allDay = (id: string, start: string, end: string): CalendarEvent => ({
  id,
  calendarId: "primary",
  start,
  end,
  allDay: true,
  title: id,
  kind: "personal",
});
const wed = new Date(2026, 9, 14, 9, 20);
const change = (id: string, at: string, extra: Partial<CalendarChange> = {}): CalendarChange => ({
  id,
  at,
  tool: "update_event",
  input: {},
  result: "",
  summary: `update_event: ${id}`,
  ...extra,
});

describe("visible range", () => {
  it("is the day, Mon–Sun, or the whole weeks around the month", () => {
    expect(visibleRange("day", wed)).toEqual({ start: new Date(2026, 9, 14), days: 1 });
    expect(visibleRange("week", wed)).toEqual({ start: new Date(2026, 9, 12), days: 7 });
    // October 2026: Thu 1 → Sat 31, so Mon 28 Sep → Sun 1 Nov.
    const month = visibleRange("month", wed);
    expect(ymd(month.start)).toBe("2026-09-28");
    expect(month.days).toBe(35);
    expect(rangeQuery(month)).toBe("start=2026-09-28&end=2026-11-01");
    expect(rangeQuery(visibleRange("week", wed))).toBe("start=2026-10-12&end=2026-10-18");
  });

  it("a Sunday belongs to the week before", () => {
    expect(ymd(visibleRange("week", new Date(2026, 9, 18)).start)).toBe("2026-10-12");
  });

  it("moves by a day, a week or a month", () => {
    expect(ymd(shift("day", wed, 1))).toBe("2026-10-15");
    expect(ymd(shift("week", wed, -1))).toBe("2026-10-07");
    expect(ymd(shift("month", new Date(2026, 0, 31), 1))).toBe("2026-02-01");
  });

  it("labels the range", () => {
    expect(rangeLabel("week", wed)).toBe("12 – 18 October 2026");
    expect(rangeLabel("week", new Date(2026, 9, 1))).toBe("28 Sep – 4 Oct 2026");
    expect(rangeLabel("week", new Date(2026, 11, 30))).toBe("28 Dec 2026 – 3 Jan 2027");
    expect(rangeLabel("day", wed)).toBe("Wednesday 14 October 2026");
    expect(rangeLabel("month", wed)).toBe("October 2026");
  });
});

describe("event layout", () => {
  it("puts overlapping events side by side and gives the rest the full width", () => {
    const day = new Date(2026, 9, 15);
    const events = [
      timed("deep", 15, [13, 0], [16, 0]),
      timed("jo", 15, [14, 0], [14, 30]),
      timed("call", 15, [14, 15], [15, 0]),
      timed("later", 15, [17, 0], [18, 0]),
    ];
    const placed = layoutDay(segmentsOn(events, day));
    const by = Object.fromEntries(placed.map((p) => [p.event.id, [p.column, p.columns]]));
    expect(by).toEqual({ deep: [0, 3], jo: [1, 3], call: [2, 3], later: [0, 1] });
  });

  it("reuses a column once its event has ended", () => {
    const day = new Date(2026, 9, 15);
    const placed = layoutDay(
      segmentsOn(
        [timed("a", 15, [9, 0], [12, 0]), timed("b", 15, [9, 0], [10, 0]), timed("c", 15, [10, 0], [11, 0])],
        day,
      ),
    );
    const by = Object.fromEntries(placed.map((p) => [p.event.id, [p.column, p.columns]]));
    expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [1, 2] });
  });

  it("back-to-back events don't overlap", () => {
    const placed = layoutDay(
      segmentsOn([timed("a", 15, [9, 0], [10, 0]), timed("b", 15, [10, 0], [11, 0])], new Date(2026, 9, 15)),
    );
    expect(placed.map((p) => p.columns)).toEqual([1, 1]);
  });

  it("sizes and places boxes in the grid, short events get a minimum height", () => {
    const [stand] = layoutDay(segmentsOn([timed("s", 14, [9, 30], [9, 45])], new Date(2026, 9, 14)));
    expect(boxOf(stand!, 8)).toEqual({ top: 1.5 * HOUR_PX, height: MIN_EVENT_PX, left: 0, width: 100 });
    expect(nowOffset(wed, 8)).toBeCloseTo((80 / 60) * HOUR_PX);
  });

  it("puts all-day events in their own row, on every day they cover", () => {
    const office = allDay("office", "2026-10-14", "2026-10-15");
    const trip = allDay("trip", "2026-10-15", "2026-10-17");
    const events = [office, trip, timed("t", 14, [9, 0], [10, 0])];
    expect(allDayOn(events, new Date(2026, 9, 14)).map((e) => e.id)).toEqual(["office"]);
    expect(allDayOn(events, new Date(2026, 9, 16)).map((e) => e.id)).toEqual(["trip"]);
    expect(allDayOn(events, new Date(2026, 9, 17))).toEqual([]);
    // …and never in the time grid.
    expect(segmentsOn(events, new Date(2026, 9, 14)).map((s) => s.event.id)).toEqual(["t"]);
  });

  it("splits an event past midnight between the two days", () => {
    const late: CalendarEvent = { ...timed("late", 14, [23, 0], [23, 0]), end: t(15, 1) };
    expect(segmentsOn([late], new Date(2026, 9, 14))[0]).toMatchObject({
      startMin: 23 * 60,
      endMin: 24 * 60,
    });
    expect(segmentsOn([late], new Date(2026, 9, 15))[0]).toMatchObject({ startMin: 0, endMin: 60 });
  });

  it("opens on 08:00–19:00 and widens the grid so earlier and later events can be scrolled to", () => {
    const day = new Date(2026, 9, 16);
    expect(gridHours(segmentsOn([timed("a", 16, [9, 0], [10, 0])], day))).toEqual({
      from: 8,
      to: 19,
      scrollTop: 0,
    });
    const segs = segmentsOn(
      [timed("swim", 16, [6, 30], [7, 15]), timed("dinner", 16, [19, 30], [21, 10])],
      day,
    );
    const hours = gridHours(segs);
    expect(hours).toEqual({ from: 6, to: 22, scrollTop: 2 * HOUR_PX });
    // The early event sits above the 08:00 the grid scrolls to, the late one below 19:00.
    const [swim, dinner] = layoutDay(segs).map((p) => boxOf(p, hours.from));
    expect(swim!.top).toBeLessThan(hours.scrollTop);
    expect(dinner!.top).toBeGreaterThanOrEqual((19 - hours.from) * HOUR_PX);
  });
});

describe("month", () => {
  it("lays out whole weeks with all-day events first", () => {
    const weeks = monthWeeks(wed, [
      timed("b", 14, [11, 0], [12, 0]),
      timed("a", 14, [9, 0], [10, 0]),
      allDay("office", "2026-10-14", "2026-10-15"),
    ]);
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    const cell = weeks.flat().find((c) => ymd(c.date) === "2026-10-14")!;
    expect(cell.events.map((e) => e.id)).toEqual(["office", "a", "b"]);
    expect(weeks[0]![0]!.inMonth).toBe(false);
  });
});

describe("changed by JARVIS", () => {
  it("describes the server's summaries", () => {
    const at = "2026-10-14T08:07:00Z";
    expect(
      describeChange(change("m", at, { summary: "update_event: Booking call → 2026-10-16T12:00:00" })),
    ).toBe("Moved “Booking call” → Fri 16 Oct 12:00");
    expect(describeChange(change("c", at, { summary: "create_event: Dentist → 2026-10-20T09:00:00" }))).toBe(
      "Created “Dentist” → Tue 20 Oct 09:00",
    );
    expect(describeChange(change("r", at, { summary: "respond_to_event: 1:1 with Jo → accepted" }))).toBe(
      "Answered “1:1 with Jo” → accepted",
    );
    expect(describeChange(change("d", at, { summary: "delete_event: Gym", undoOf: "x" }))).toBe(
      "Undo: Deleted “Gym”",
    );
    expect(describeChange(change("o", at, { summary: "Something else" }))).toBe("Something else");
  });

  it("shows the time today and the weekday before", () => {
    expect(changeTime(change("a", new Date(2026, 9, 14, 9, 7).toISOString()), wed)).toBe("09:07");
    expect(changeTime(change("a", new Date(2026, 9, 12, 18, 20).toISOString()), wed)).toBe("Mon 18:20");
  });

  it("offers Undo on the newest change that isn't undone and isn't an undo", () => {
    const log = [
      change("old", "2026-10-12T10:00:00Z"),
      change("done", "2026-10-13T10:00:00Z", { undoneAt: "2026-10-13T11:00:00Z" }),
      change("undo", "2026-10-13T11:00:00Z", { undoOf: "done" }),
    ];
    expect(latestUndoable(log)?.id).toBe("old");
    expect(latestUndoable([...log, change("new", "2026-10-14T08:00:00Z")])?.id).toBe("new");
    expect(latestUndoable([])).toBeUndefined();
  });

  it("merges a live change into the log and marks what an undo undid", () => {
    const old = [change("a", "2026-10-12T10:00:00Z"), change("b", "2026-10-13T10:00:00Z")];
    const merged = mergeChanges([change("u", "2026-10-14T10:00:00Z", { undoOf: "b" })], old);
    expect(merged.map((c) => c.id)).toEqual(["u", "b", "a"]);
    expect(merged.find((c) => c.id === "b")?.undoneAt).toBe("2026-10-14T10:00:00Z");
    // The fetched copy wins over the old one.
    expect(mergeChanges([change("a", "2026-10-12T10:00:00Z", { summary: "new" })], old)[1]?.summary).toBe(
      "new",
    );
  });
});

describe("new event", () => {
  it("is a sentence for JARVIS", () => {
    expect(
      newEventText({
        title: " Booking call ",
        day: "2026-10-16",
        start: "12:00",
        minutes: 30,
        guests: "Sam",
      }),
    ).toBe("Create ‘Booking call’ Fri 16 Oct 12:00 for 30 min with Sam");
    expect(
      newEventText({
        title: "Plan",
        day: "2026-10-19",
        start: "09:30",
        minutes: 90,
        guests: "Sam, Jo and Priya",
      }),
    ).toBe("Create ‘Plan’ Mon 19 Oct 09:30 for 1 hour 30 min with Sam, Jo and Priya");
    expect(newEventText({ title: "Gym", day: "2026-10-19", start: "18:00", minutes: 120, guests: "" })).toBe(
      "Create ‘Gym’ Mon 19 Oct 18:00 for 2 hours",
    );
  });

  it("finds a Notion link in a description", () => {
    expect(notionLink("Agenda: https://www.notion.so/Trip-agenda-3f92 (flights)")).toBe(
      "https://www.notion.so/Trip-agenda-3f92",
    );
    expect(notionLink("See https://acme.notion.site/page")).toBe("https://acme.notion.site/page");
    expect(notionLink("No link here")).toBeUndefined();
    expect(notionLink(undefined)).toBeUndefined();
  });
});

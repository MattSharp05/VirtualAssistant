import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CalendarChange, CalendarResponse } from "@jarvis/shared";
import calendarRoutes from "../src/desk/routes/calendar.js";
import { DeskHttpError, type DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { freeSlots } from "../src/freeSlots.js";
import { CALENDAR_JOB, CalendarCache, kindOf, runnerFetch, useCalendarCache, validateEvents } from "../src/jobs/calendarRange.js";
import { discoverJobs, JobRunner, useJobRunner } from "../src/jobs/index.js";

process.env.TZ = "Europe/London";

const WEEK = {
  range: { start: "2026-10-12T00:00:00+01:00", end: "2026-10-19T00:00:00+01:00" },
  events: [
    { id: "e2", calendarId: "matthew@work.example", start: "2026-10-13T12:30:00+01:00", end: "2026-10-13T13:30:00+01:00", allDay: false, title: "Lunch with Sam", kind: "personal" },
    { id: "e1", calendarId: "primary", start: "2026-10-12T09:30:00+01:00", end: "2026-10-12T09:45:00+01:00", allDay: false, title: "Standup", kind: "work", attendees: [{ name: "Priya", email: "p@x.io", response: "accepted" }] },
    { id: "e3", calendarId: "primary", start: "2026-10-14", end: "2026-10-15", title: "Office day", kind: "personal" },
  ],
};

const route = (path: string, method = "GET") => calendarRoutes.find((r) => r.path === path && r.method === method)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { delayMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cal-"));
  const jarvis = {};
  const bus = new EventBus();
  let payload: unknown = WEEK;
  const prompts: string[] = [];
  // A fake worker brain: "calls" submit_events with the payload, like the real worker would.
  const worker = {
    reset: () => undefined,
    chat: async (prompt: string) => {
      prompts.push(prompt);
      await sleep(opts.delayMs ?? 0);
      if (payload) runner.submit(CALENDAR_JOB, payload);
    },
  };
  const runner: JobRunner = new JobRunner(await discoverJobs(), worker, {} as never, { dataDir: dir, timeoutMs: 2000 });
  useJobRunner(jarvis, runner);
  let now = Date.parse("2026-10-12T08:00:00Z");
  const cache = new CalendarCache(runnerFetch(jarvis), bus, () => now);
  useCalendarCache(jarvis, cache);
  const ctx = { jarvis, bus } as unknown as DeskContext;
  const get = (query: string) => route("/calendar").handler({ ctx, url: new URL(`http://x/api/desk/calendar?${query}`) } as never) as Promise<CalendarResponse>;
  return {
    bus,
    prompts,
    get,
    ctx,
    advance: (ms: number) => (now += ms),
    setPayload: (p: unknown) => (payload = p),
  };
}

test("submit_events: validated, sorted, all-day and kind filled in", () => {
  const out = validateEvents(WEEK);
  assert.deepEqual(out.events.map((e) => e.id), ["e1", "e2", "e3"]);
  assert.equal(out.events[2].allDay, true, "a date-only start is all-day");
  assert.equal(out.events[0].attendees?.[0].response, "accepted");
  assert.throws(() => validateEvents({ ...WEEK, events: [{ id: "x", start: "2026-10-12T09:00:00Z", title: "No end" }] }), /events\[0\]\.end is required/);
  assert.throws(() => validateEvents({ events: [] }), /range\.start is required/);
  assert.equal(kindOf("Focus time", "primary", "work"), "focus");
  assert.equal(kindOf("Deep work block", "primary"), "focus");
  assert.equal(kindOf("Standup", "work calendar"), "work");
  assert.equal(kindOf("Dentist", "primary"), "personal");
  assert.equal(kindOf("Board prep", "primary", "work"), "work", "the worker's call when the title doesn't say focus");
});

test("a range is fetched once and cached for 10 minutes", async () => {
  const s = await setup();
  const first = await s.get("start=2026-10-12&end=2026-10-18");
  assert.equal(s.prompts.length, 1);
  assert.match(s.prompts[0], /from 2026-10-12T00:00:00\+01:00 to 2026-10-19T00:00:00\+01:00/, "a date end includes that day");
  assert.deepEqual(first.range, WEEK.range);
  assert.deepEqual(first.events.map((e) => e.title), ["Standup", "Lunch with Sam", "Office day"]);
  assert.equal(first.ageSeconds, 0);
  assert.ok(first.free?.some((f) => f.start === "2026-10-12T09:45:00+01:00"), "free slots worked out by the server");

  s.advance(9 * 60_000);
  const again = await s.get("start=2026-10-12&end=2026-10-18");
  assert.equal(s.prompts.length, 1, "served from the cache");
  assert.equal(again.ageSeconds, 540);

  // A day inside a cached week is answered from it.
  const tuesday = await s.get("start=2026-10-13&end=2026-10-13");
  assert.equal(s.prompts.length, 1);
  assert.deepEqual(tuesday.events.map((e) => e.id), ["e2"]);

  s.advance(2 * 60_000); // 11 min old
  await s.get("start=2026-10-12&end=2026-10-18");
  assert.equal(s.prompts.length, 2, "stale after 10 minutes");
});

test("calendar.changed drops the cache", async () => {
  const s = await setup();
  await s.get("start=2026-10-12&end=2026-10-18");
  s.bus.publish({ type: "calendar.changed", entry: { id: "c1" } as CalendarChange });
  await s.get("start=2026-10-12&end=2026-10-18");
  assert.equal(s.prompts.length, 2);
  await s.get("start=2026-10-12&end=2026-10-18");
  assert.equal(s.prompts.length, 2);
});

test("concurrent requests for a range run one job; POST refresh runs it again", async () => {
  const s = await setup({ delayMs: 30 });
  const [a, b] = await Promise.all([s.get("start=2026-10-12&end=2026-10-18"), s.get("start=2026-10-12&end=2026-10-18")]);
  assert.equal(s.prompts.length, 1);
  assert.deepEqual(a, b);
  const refreshed = (await route("/calendar/refresh", "POST").handler({ ctx: s.ctx, url: new URL("http://x/"), body: { start: "2026-10-12", end: "2026-10-18" } } as never)) as CalendarResponse;
  assert.equal(s.prompts.length, 2);
  assert.equal(refreshed.events.length, 3);
});

test("a failed fetch: 502 with nothing cached, else the last copy marked stale", async () => {
  const s = await setup();
  s.setPayload(undefined); // the worker never submits
  await assert.rejects(s.get("start=2026-10-12&end=2026-10-18"), (e: DeskHttpError) => e.status === 502 && /without calling submit_events/.test(e.message));
  s.setPayload(WEEK);
  await s.get("start=2026-10-12&end=2026-10-18");
  s.advance(11 * 60_000);
  s.setPayload(undefined);
  const stale = await s.get("start=2026-10-12&end=2026-10-18");
  assert.equal(stale.stale, true);
  assert.equal(stale.ageSeconds, 660);
  assert.match(stale.lastError ?? "", /submit_events/);
  // The other range's earlier result is never passed off as this one's.
  await assert.rejects(s.get("start=2026-11-02&end=2026-11-08"), (e: DeskHttpError) => e.status === 502);
});

test("bad ranges are refused", async () => {
  const s = await setup();
  for (const [q, why] of [
    ["end=2026-10-18", /start is required/],
    ["start=2026-10-18&end=2026-10-12", /end must be after start/],
    ["start=2026-10-01&end=2026-11-30", /at most 42 days/],
    ["start=soon&end=2026-10-18", /must be a date/],
  ] as const) {
    await assert.rejects(s.get(q), (e: DeskHttpError) => e.status === 400 && why.test(e.message), q);
  }
  await s.get("start=2026-10-01&end=2026-11-11"); // exactly 42 days
  assert.equal(s.prompts.length, 1);
});

test("free slots for a sample week: working hours, weekdays, overlaps merged, all-day events don't block", () => {
  const t = (d: string, hm: string) => `2026-10-${d}T${hm}:00+01:00`;
  const events = [
    // Mon: overlapping meetings, then lunch
    { start: t("12", "09:30"), end: t("12", "10:00") },
    { start: t("12", "09:45"), end: t("12", "10:30") },
    { start: t("12", "12:30"), end: t("12", "13:30") },
    // Tue: an all-day event, an early meeting running into the day, a late one past 18:00
    { start: "2026-10-13", end: "2026-10-14", allDay: true },
    { start: t("13", "08:00"), end: t("13", "09:15") },
    { start: t("13", "17:45"), end: t("13", "19:00") },
    // Wed: offsite all day
    { start: t("14", "09:00"), end: t("14", "18:00") },
    // Thu: a 20-minute gap (too short)
    { start: t("15", "10:00"), end: t("15", "10:20") },
    { start: t("15", "10:40"), end: t("15", "11:00") },
    // Sat: weekends aren't offered
    { start: t("17", "10:00"), end: t("17", "11:00") },
  ];
  const slots = freeSlots(events, { from: new Date(t("12", "00:00")), to: new Date(t("19", "00:00")) });
  assert.deepEqual(
    slots.map((s) => `${s.start.slice(8, 16)}–${s.end.slice(11, 16)}`),
    ["12T09:00–09:30", "12T10:30–12:30", "12T13:30–18:00", "13T09:15–17:45", "15T09:00–10:00", "15T11:00–18:00", "16T09:00–18:00"],
  );
  assert.equal(slots[0].start, "2026-10-12T09:00:00+01:00", "in Matthew's time zone");

  // Starting mid-afternoon on Friday; a shorter minimum keeps Thursday's 20-minute gap.
  const friday = freeSlots(events, { from: new Date(t("16", "14:10")), to: new Date(t("19", "00:00")) });
  assert.deepEqual(friday, [{ start: t("16", "14:10"), end: t("16", "18:00") }]);
  const short = freeSlots(events, { from: new Date(t("15", "00:00")), to: new Date(t("16", "00:00")), minMinutes: 15 });
  assert.equal(short.length, 3);
});

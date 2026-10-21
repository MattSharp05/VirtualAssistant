import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CalendarChange, DeskEvent } from "@jarvis/shared";
import { CalendarLog, useCalendarLog } from "../src/calendarLog.js";
import type { Config } from "../src/config.js";
import calendarRoutes from "../src/desk/routes/calendar.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { GoogleCalendarApi, useGoogleCalendar } from "../src/googleCalendar.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import calendarTools from "../src/tools/calendar.js";
import { CREDS, fakeGoogleCalendar } from "./helpers/fakeGoogleCalendar.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-cal-"));
const tool = (name: string) => calendarTools.tools.find((t) => t.name === name)!;
const eventId = (entry: CalendarChange) => (JSON.parse(entry.result) as { id?: string }).id!;

function setup() {
  const dir = tmp();
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const cal = fakeGoogleCalendar();
  const config = { googleCalendar: { ...CREDS, calendarId: "primary", timeZone: "Europe/London" }, timeZone: "Europe/London" } as unknown as Config;
  const jarvis = new Jarvis(config, new Store(dir));
  const log = new CalendarLog(dir, bus);
  useCalendarLog(jarvis, log);
  useGoogleCalendar(jarvis, new GoogleCalendarApi(CREDS, cal.fetchImpl));
  const ctx = { jarvis, config };
  return { bus, events, cal, log, ctx };
}

test("create_event logs with no before; the log and bus agree", async () => {
  const { log, ctx, events } = setup();
  const result = await tool("create_event").handler({ summary: "JARVIS test", start: "2026-10-16T15:00:00", end: "2026-10-16T15:30:00" }, ctx);
  assert.match(result, /^Created JARVIS test → 2026-10-16T15:00:00 \[id \S+\]\.$/);

  const [entry] = log.recent();
  assert.equal(entry.tool, "create_event");
  assert.equal(entry.before, undefined, "create_event has no before");
  assert.match(entry.summary, /^create_event: JARVIS test → 2026-10-16T15:00:00/);
  assert.deepEqual(
    events.filter((e) => e.type === "calendar.changed").map((e) => (e.type === "calendar.changed" ? e.entry.id : undefined)),
    [entry.id],
  );
});

test("update_event logs a before snapshot; undo restores the earlier fields and marks it undone", async () => {
  const { log, ctx } = setup();
  await tool("create_event").handler({ summary: "Booking call", start: "2026-10-16T14:00:00", end: "2026-10-16T14:30:00" }, ctx);
  const id = eventId(log.recent()[0]);

  const moved = await tool("update_event").handler({ eventId: id, start: "2026-10-17T14:00:00" }, ctx);
  assert.match(moved, /Updated Booking call → 2026-10-17T14:00:00/);
  const [updateEntry] = log.recent();
  assert.equal(updateEntry.tool, "update_event");
  assert.match(JSON.parse(updateEntry.before!).start.dateTime, /2026-10-16T14:00:00/);

  const undo = await tool("undo_calendar_change").handler({}, ctx);
  assert.match(undo, /Undid "update_event: Booking call → 2026-10-17T14:00:00": restored Booking call → 2026-10-16T14:00:00/);
  const [reversal, original] = log.recent();
  assert.equal(reversal.undoOf, original.id);
  assert.equal(reversal.tool, "update_event");
  assert.ok(original.undoneAt, "marked undone after the reversal");

  const after = await tool("list_events").handler({ start: "2026-10-16T00:00:00Z", end: "2026-10-18T00:00:00Z" }, ctx);
  assert.match(after, /Booking call → 2026-10-16T14:00:00/);

  await assert.rejects(tool("undo_calendar_change").handler({ id: "nope" }, ctx), /No calendar change nope/);
});

test("delete_event logs a before snapshot; undo re-creates the event", async () => {
  const { cal, log, ctx } = setup();
  await tool("create_event").handler({ summary: "Dentist", start: "2026-10-20T09:00:00", end: "2026-10-20T09:30:00" }, ctx);
  const id = eventId(log.recent()[0]);

  const deleted = await tool("delete_event").handler({ eventId: id }, ctx);
  assert.match(deleted, /Deleted Dentist → 2026-10-20T09:00:00/);
  assert.equal(cal.events.size, 0);
  const [deleteEntry] = log.recent();
  assert.equal(deleteEntry.tool, "delete_event");
  assert.match(deleteEntry.before!, /Dentist/);

  const undo = await tool("undo_calendar_change").handler({}, ctx);
  assert.match(undo, /Undid "delete_event: Dentist → 2026-10-20T09:00:00": re-created Dentist/);
  assert.equal(cal.events.size, 1, "the event is back");
  const [reversal] = log.recent();
  assert.equal(reversal.tool, "create_event");
});

test("respond logs the previous RSVP; undo restores it", async () => {
  const { cal, log, ctx } = setup();
  await tool("create_event").handler({ summary: "Team sync", start: "2026-10-16T09:00:00", end: "2026-10-16T09:30:00" }, ctx);
  const id = eventId(log.recent()[0]);
  // The fake has no attendee list of its own yet; give it one with Matthew as `self`.
  (cal.events.get(id) as { attendees: unknown }).attendees = [{ email: "matthew@example.com", self: true, responseStatus: "needsAction" }];

  const rsvp = await tool("respond").handler({ eventId: id, response: "accepted" }, ctx);
  assert.match(rsvp, /RSVP'd accepted to Team sync/);
  const [respondEntry] = log.recent();
  assert.equal(respondEntry.tool, "respond");
  assert.match(respondEntry.before!, /needsAction/);

  const undo = await tool("undo_calendar_change").handler({}, ctx);
  assert.match(undo, /RSVP restored to needsAction/);
});

test("undo of a create_event deletes what it created, then there's nothing left to undo", async () => {
  const { cal, ctx } = setup();
  await tool("create_event").handler({ summary: "JARVIS test", start: "2026-10-16T15:00:00", end: "2026-10-16T15:30:00" }, ctx);
  assert.equal(cal.events.size, 1);

  const undo = await tool("undo_calendar_change").handler({}, ctx);
  assert.match(undo, /Undid "create_event: JARVIS test.*": deleted JARVIS test/);
  assert.equal(cal.events.size, 0);

  await assert.rejects(tool("undo_calendar_change").handler({}, ctx), /no calendar change of mine to undo/);
});

test("an undo can't itself be undone", async () => {
  const { log, ctx } = setup();
  await tool("create_event").handler({ summary: "JARVIS test", start: "2026-10-16T15:00:00", end: "2026-10-16T15:30:00" }, ctx);
  await tool("undo_calendar_change").handler({}, ctx);
  assert.equal(log.recent().filter((e) => !e.undoneAt && !e.undoOf).length, 0);
  await assert.rejects(tool("undo_calendar_change").handler({}, ctx), /no calendar change of mine to undo/);
});

test("without Google Calendar credentials, every calendar tool fails clearly", async () => {
  const dir = tmp();
  const jarvis = new Jarvis({} as unknown as Config, new Store(dir));
  useCalendarLog(jarvis, new CalendarLog(dir));
  const ctx = { jarvis, config: {} as Config };
  const args = { start: "2026-10-16", end: "2026-10-17", eventId: "x", summary: "x", response: "accepted" };
  for (const name of ["list_events", "create_event", "update_event", "delete_event", "respond"]) {
    await assert.rejects(tool(name).handler(args, ctx), /isn't connected yet/, name);
  }
});

test("GET /api/desk/calendar/log reflects the change log", async () => {
  const { ctx } = setup();
  await tool("create_event").handler({ summary: "JARVIS test", start: "2026-10-16T15:00:00", end: "2026-10-16T15:30:00" }, ctx);
  const res = (await calendarRoutes.find((r) => r.path === "/calendar/log")!.handler({ ctx: { jarvis: ctx.jarvis } as unknown as DeskContext } as never)) as { changes: CalendarChange[] };
  assert.deepEqual(res.changes.map((c) => c.tool), ["create_event"]);
});

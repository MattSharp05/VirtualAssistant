import assert from "node:assert/strict";
import { test } from "node:test";
import { googleCalendarApi, GoogleCalendarApi, selfAttendee } from "../src/googleCalendar.js";
import { CREDS, fakeGoogleCalendar } from "./helpers/fakeGoogleCalendar.js";

test("token refresh: fetched once, cached, refreshed again once expired", async () => {
  const cal = fakeGoogleCalendar();
  let now = 1_000_000;
  const api = new GoogleCalendarApi(CREDS, cal.fetchImpl, () => now);
  await api.createEvent({ summary: "a", start: { date: "2027-01-01" }, end: { date: "2027-01-02" } });
  await api.createEvent({ summary: "b", start: { date: "2027-01-01" }, end: { date: "2027-01-02" } });
  assert.equal(cal.tokenCalls(), 1, "second call reuses the cached token");
  now += 3601 * 1000; // past expiry
  await api.createEvent({ summary: "c", start: { date: "2027-01-01" }, end: { date: "2027-01-02" } });
  assert.equal(cal.tokenCalls(), 2, "refreshed once the token expired");
});

test("createEvent/getEvent/updateEvent/deleteEvent round-trip", async () => {
  const cal = fakeGoogleCalendar();
  const api = new GoogleCalendarApi(CREDS, cal.fetchImpl);
  const created = await api.createEvent({ summary: "Booking call", start: { dateTime: "2026-10-16T14:00:00", timeZone: "Europe/London" }, end: { dateTime: "2026-10-16T14:30:00", timeZone: "Europe/London" } });
  assert.ok(created.id);
  const fetched = await api.getEvent(created.id!);
  assert.equal(fetched.summary, "Booking call");
  const updated = await api.updateEvent(created.id!, { start: { dateTime: "2026-10-17T14:00:00", timeZone: "Europe/London" } });
  assert.equal(updated.start?.dateTime, "2026-10-17T14:00:00");
  assert.equal(updated.summary, "Booking call", "a partial patch keeps other fields");
  await api.deleteEvent(created.id!);
  await assert.rejects(api.getEvent(created.id!), /404/);
});

test("listEvents returns events sorted by start", async () => {
  const cal = fakeGoogleCalendar();
  const api = new GoogleCalendarApi(CREDS, cal.fetchImpl);
  await api.createEvent({ summary: "Later", start: { dateTime: "2026-10-16T15:00:00" }, end: { dateTime: "2026-10-16T15:30:00" } });
  await api.createEvent({ summary: "Earlier", start: { dateTime: "2026-10-16T09:00:00" }, end: { dateTime: "2026-10-16T09:30:00" } });
  const events = await api.listEvents("2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z");
  assert.deepEqual(events.map((e) => e.summary), ["Earlier", "Later"]);
});

test("respond: PATCHes only the self attendee, keeping other guests' responses", async () => {
  const cal = fakeGoogleCalendar();
  const api = new GoogleCalendarApi(CREDS, cal.fetchImpl);
  const created = await api.createEvent({
    summary: "Team sync",
    start: { dateTime: "2026-10-16T09:00:00" },
    end: { dateTime: "2026-10-16T09:30:00" },
    attendees: [{ email: "matthew@example.com", self: true, responseStatus: "needsAction" }, { email: "alex@example.com", responseStatus: "accepted" }],
  });
  const updated = await api.respond(created.id!, "accepted");
  assert.equal(selfAttendee(updated)?.responseStatus, "accepted");
  assert.equal(updated.attendees?.find((a) => a.email === "alex@example.com")?.responseStatus, "accepted", "other guest untouched");
});

test("respond without a self attendee fails clearly", async () => {
  const cal = fakeGoogleCalendar();
  const api = new GoogleCalendarApi(CREDS, cal.fetchImpl);
  const created = await api.createEvent({ summary: "No guests", start: { dateTime: "2026-10-16T09:00:00" }, end: { dateTime: "2026-10-16T09:30:00" } });
  await assert.rejects(api.respond(created.id!, "accepted"), /not listed as a guest/);
});

test("a bad refresh token surfaces a readable error", async () => {
  const cal = fakeGoogleCalendar();
  const api = new GoogleCalendarApi({ ...CREDS, refreshToken: "wrong" }, cal.fetchImpl);
  await assert.rejects(api.listEvents("2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z"), /token refresh failed/);
});

test("googleCalendarApi throws a clear error with no credentials", () => {
  assert.throws(() => googleCalendarApi(undefined), /isn't connected yet/);
});

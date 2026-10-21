// Calendar (JD-77): JARVIS's own tools, backed by the first-party Google Calendar client
// (src/googleCalendar.ts), not a claude.ai connector — that connector's write tools kept dropping
// out, so "add X to my calendar" could fail. Every write logs to src/calendarLog.ts for the change
// log and undo (ADR 0008); undo_calendar_change performs the reversal itself (no round trip through
// the brain).
import { calendarLogFor, type CalendarWriteTool } from "../calendarLog.js";
import {
  googleCalendarFor,
  selfAttendee,
  type CalendarAttendeeApi,
  type CalendarEventApi,
} from "../googleCalendar.js";
import { JarvisError } from "../jarvis.js";
import { schema, str, type ToolContext, type ToolGroup } from "./types.js";

const RESPONSES = ["accepted", "declined", "tentative"] as const;
type Response = (typeof RESPONSES)[number];

const api = (ctx: ToolContext) => googleCalendarFor(ctx.jarvis, ctx.config.googleCalendar);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function when(value: unknown, field: string): { date?: string; dateTime?: string; timeZone?: string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value);
  if (DATE_ONLY.test(v)) return { date: v };
  if (Number.isNaN(Date.parse(v))) throw new JarvisError(`${field} must be a date (YYYY-MM-DD) or an ISO date-time.`);
  return { dateTime: v };
}

function attendeesOf(value: unknown): CalendarAttendeeApi[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new JarvisError("attendees must be a list of { email, name? }.");
  return value.map((a) => {
    const row = a as { email?: unknown; name?: unknown };
    if (!row.email || typeof row.email !== "string") throw new JarvisError("Each attendee needs an email.");
    return { email: row.email, ...(row.name ? { displayName: String(row.name) } : {}) };
  });
}

function eventBody(a: Record<string, unknown>, tz: string): CalendarEventApi {
  const start = when(a.start, "start");
  const end = when(a.end, "end");
  const withZone = (w: { date?: string; dateTime?: string; timeZone?: string } | undefined) => (w?.dateTime ? { ...w, timeZone: String(a.timeZone ?? tz) } : w);
  return {
    ...(a.summary !== undefined ? { summary: String(a.summary) } : {}),
    ...(a.description !== undefined ? { description: String(a.description) } : {}),
    ...(a.location !== undefined ? { location: String(a.location) } : {}),
    ...(start ? { start: withZone(start) } : {}),
    ...(end ? { end: withZone(end) } : {}),
    ...(a.attendees !== undefined ? { attendees: attendeesOf(a.attendees) } : {}),
  };
}

/** Title → time, no id (for the change log and "Undid" messages). */
function label(e: CalendarEventApi): string {
  const time = e.start?.dateTime ?? e.start?.date ?? "";
  return `${e.summary ?? "(no title)"}${time ? ` → ${time}` : ""}`;
}

/** label() plus the id (for what a tool call hands back to the model, so it can refer to the event again). */
function describeEvent(e: CalendarEventApi): string {
  return `${label(e)}${e.id ? ` [id ${e.id}]` : ""}`;
}

async function logWrite(
  ctx: ToolContext,
  tool: CalendarWriteTool,
  input: Record<string, unknown>,
  result: CalendarEventApi | { deleted: true },
  before?: CalendarEventApi,
  summaryOf: (r: CalendarEventApi | { deleted: true }) => string = (r) => ("deleted" in r ? "deleted" : label(r)),
): Promise<void> {
  await calendarLogFor(ctx.jarvis).record({
    tool,
    input,
    result: JSON.stringify(result),
    ...(before ? { before: JSON.stringify(before) } : {}),
    summary: `${tool}: ${summaryOf(result)}`,
  });
}

function fmtList(events: CalendarEventApi[]): string {
  if (!events.length) return "Nothing on the calendar in that range.";
  return events.map((e) => `- ${describeEvent(e)}`).join("\n");
}

/** Strips server-assigned fields so an event resource can be replayed into createEvent (undo). */
function forCreate(e: CalendarEventApi): CalendarEventApi {
  const { id, htmlLink, status, ...rest } = e;
  return rest;
}

const group: ToolGroup = {
  name: "calendar",
  promptHint:
    "- Calendar is JARVIS's own (not a claude.ai connector): \"what's on today/this week\" → list_events for that range. Create, move, edit, delete and RSVP without asking first (ADR 0008): only add guests Matthew names; give times in his calendar time zone (no UTC offset unless he gives one). After a change, say what happened in one line (\"Moved Booking call to Fri 14:00\"). \"Undo that\" → undo_calendar_change.",
  tools: [
    {
      name: "list_events",
      description: "List calendar events in a range.",
      inputSchema: schema({ start: str("Range start: a date (YYYY-MM-DD) or ISO date-time"), end: str("Range end (exclusive)") }, ["start", "end"]),
      handler: async (a, ctx) => {
        const events = await api(ctx).listEvents(String(a.start), String(a.end), 50);
        return fmtList(events);
      },
    },
    {
      name: "create_event",
      description: "Create a calendar event.",
      inputSchema: schema(
        {
          summary: str("Title"),
          start: str("Start: a date (YYYY-MM-DD, for an all-day event) or an ISO date-time"),
          end: str("End (exclusive for an all-day event)"),
          description: str("Description (optional)"),
          location: str("Where (optional)"),
          attendees: { type: "array", description: "Guests to invite (optional); only add people Matthew names", items: { type: "object", properties: { email: str("Email"), name: str("Display name (optional)") }, required: ["email"] } },
          timeZone: str("IANA time zone for start/end times (optional; defaults to Matthew's calendar time zone)"),
        },
        ["summary", "start", "end"],
      ),
      handler: async (a, ctx) => {
        const tz = ctx.config.googleCalendar?.timeZone ?? ctx.config.timeZone ?? "Europe/London";
        const body = eventBody(a, tz);
        const created = await api(ctx).createEvent(body);
        await logWrite(ctx, "create_event", a, created);
        return `Created ${describeEvent(created)}.`;
      },
    },
    {
      name: "update_event",
      description: "Change a calendar event's title, time, description, location or guests.",
      inputSchema: schema(
        {
          eventId: str("The event's id (from list_events or a previous create_event/update_event)"),
          summary: str("New title (optional)"),
          start: str("New start (optional)"),
          end: str("New end (optional)"),
          description: str("New description (optional)"),
          location: str("New location (optional)"),
          attendees: { type: "array", description: "Replace the guest list (optional); only add people Matthew names", items: { type: "object", properties: { email: str("Email"), name: str("Display name (optional)") }, required: ["email"] } },
          timeZone: str("IANA time zone for start/end times (optional)"),
        },
        ["eventId"],
      ),
      handler: async (a, ctx) => {
        const tz = ctx.config.googleCalendar?.timeZone ?? ctx.config.timeZone ?? "Europe/London";
        const eventId = String(a.eventId);
        const client = api(ctx);
        const before = await client.getEvent(eventId);
        const patch = eventBody(a, tz);
        const updated = await client.updateEvent(eventId, patch);
        await logWrite(ctx, "update_event", a, updated, before);
        return `Updated ${describeEvent(updated)}.`;
      },
    },
    {
      name: "delete_event",
      description: "Delete a calendar event.",
      inputSchema: schema({ eventId: str("The event's id") }, ["eventId"]),
      handler: async (a, ctx) => {
        const eventId = String(a.eventId);
        const client = api(ctx);
        const before = await client.getEvent(eventId);
        await client.deleteEvent(eventId);
        await logWrite(ctx, "delete_event", a, { deleted: true }, before, () => label(before));
        return `Deleted ${describeEvent(before)}.`;
      },
    },
    {
      name: "respond",
      description: "RSVP to a calendar event you're invited to (accepted, declined or tentative).",
      inputSchema: schema({ eventId: str("The event's id"), response: { type: "string", enum: RESPONSES, description: "accepted, declined or tentative" } }, ["eventId", "response"]),
      handler: async (a, ctx) => {
        const response = String(a.response) as Response;
        if (!RESPONSES.includes(response)) throw new JarvisError(`response must be one of ${RESPONSES.join(", ")}.`);
        const eventId = String(a.eventId);
        const client = api(ctx);
        const before = await client.getEvent(eventId);
        const updated = await client.respond(eventId, response);
        await logWrite(ctx, "respond", a, updated, before, () => `${response} → ${label(updated)}`);
        return `RSVP'd ${response} to ${describeEvent(updated)}.`;
      },
    },
    {
      name: "undo_calendar_change",
      description: "Undo a calendar change you made (default: the latest). Reverses it and tells you what happened.",
      inputSchema: schema({ id: str("Change id from the log (optional; default the latest)") }),
      handler: async (a, ctx) => {
        const log = calendarLogFor(ctx.jarvis);
        const entry = log.pick(a.id ? String(a.id) : undefined);
        const client = api(ctx);
        const before = entry.before ? (JSON.parse(entry.before) as CalendarEventApi) : undefined;
        log.markPending(entry.id);
        if (entry.tool === "create_event") {
          const created = JSON.parse(entry.result) as CalendarEventApi;
          if (!created.id) throw new JarvisError("Can't undo: the created event has no id in the log.");
          await client.deleteEvent(created.id);
          await logWrite(ctx, "delete_event", { eventId: created.id }, { deleted: true }, created, () => label(created));
          return `Undid "${entry.summary}": deleted ${describeEvent(created)}.`;
        }
        if (!before) throw new JarvisError(`Can't undo "${entry.summary}": no earlier copy was saved.`);
        if (entry.tool === "delete_event") {
          const recreated = await client.createEvent(forCreate(before));
          await logWrite(ctx, "create_event", forCreate(before) as unknown as Record<string, unknown>, recreated);
          return `Undid "${entry.summary}": re-created ${describeEvent(recreated)}.`;
        }
        if (entry.tool === "update_event") {
          const eventId = String((entry.input as { eventId?: unknown }).eventId);
          const restored = await client.updateEvent(eventId, forCreate(before));
          await logWrite(ctx, "update_event", { eventId, ...forCreate(before) }, restored, JSON.parse(entry.result) as CalendarEventApi);
          return `Undid "${entry.summary}": restored ${describeEvent(restored)}.`;
        }
        // respond (the previous status may be "needsAction", i.e. no RSVP yet — still a valid thing to restore)
        const eventId = String((entry.input as { eventId?: unknown }).eventId);
        const prev = selfAttendee(before)?.responseStatus;
        if (!prev) throw new JarvisError(`Can't undo "${entry.summary}": no earlier RSVP was saved.`);
        const restored = await client.respond(eventId, prev);
        await logWrite(ctx, "respond", { eventId, response: prev }, restored, JSON.parse(entry.result) as CalendarEventApi, () => `${prev} → ${label(restored)}`);
        return `Undid "${entry.summary}": RSVP restored to ${prev} for ${describeEvent(restored)}.`;
      },
    },
  ],
};

export default group;

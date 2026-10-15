// The Calendar window (JD-35) for the preview, e2e and snapshots: the demo week with a Notion-linked
// meeting, overlapping and early events; JARVIS changing the calendar; the first fetch; a failure.
import type { CalendarChange, CalendarEvent, CalendarResponse, DeskEvent } from "@jarvis/shared";
import { PENDING } from "../bridge";
import demoCalendar from "../data/calendar";
import { changes } from "../data/calendar-window";
import type { Scenario } from "../types";

/** Wednesday 14 October 2026, 09:20 in London: the demo week's "today". */
const ui = { now: "2026-10-14T09:20:00+01:00" };
const demo = demoCalendar.data!["/calendar"] as CalendarResponse;
const at = (day: number, hm: string) => `2026-10-${day}T${hm}:00+01:00`;

const extra: CalendarEvent[] = [
  {
    id: "x1",
    calendarId: "work",
    start: at(14, "16:00"),
    end: at(14, "16:45"),
    allDay: false,
    title: "Trip planning call",
    kind: "work",
    location: "Google Meet",
    link: "https://meet.google.com/xyz-trip-plan",
    attendees: [
      { name: "Sam", email: "sam@example.com", response: "accepted" },
      { name: "Jo", email: "jo@example.com", response: "accepted" },
      { name: "Priya", email: "priya@example.com", response: "tentative" },
    ],
    description:
      "Agenda in Notion: flights, budget split, accommodation shortlist. https://www.notion.so/Trip-planning-agenda-3f924983f3ca81aa",
  },
  {
    id: "x2",
    calendarId: "work",
    start: at(15, "14:00"),
    end: at(15, "14:30"),
    allDay: false,
    title: "1:1 with Jo",
    kind: "work",
  },
  {
    id: "x3",
    calendarId: "primary",
    start: at(16, "07:00"),
    end: at(16, "07:45"),
    allDay: false,
    title: "Early swim",
    kind: "personal",
  },
];

const week: CalendarResponse = { ...demo, events: [...demo.events, ...extra] };
const data = {
  "/calendar": week,
  "/calendar/free": demoCalendar.data!["/calendar/free"],
  "/calendar/log": { changes },
};

const moved: CalendarChange = {
  id: "c3",
  at: "2026-10-14T08:07:00Z",
  tool: "update_event",
  input: { eventId: "x4", startTime: "2026-10-16T12:00:00" },
  result: "Updated Booking call",
  before: "Booking call, Thu 15 Oct 11:00–11:30",
  summary: "update_event: Booking call → 2026-10-16T12:00:00",
};
const booking: CalendarEvent = {
  id: "x4",
  calendarId: "work",
  start: at(16, "12:00"),
  end: at(16, "12:30"),
  allDay: false,
  title: "Booking call",
  kind: "work",
  attendees: [{ name: "Sam", email: "sam@example.com", response: "accepted" }],
};
const changed: DeskEvent = { type: "calendar.changed", entry: moved };

const scenarios: Scenario[] = [
  {
    name: "calendar",
    description:
      "Calendar window: the demo week (12–18 Oct), today Wednesday, with free slots and JARVIS's changes.",
    data,
    events: [],
    ui,
  },
  {
    name: "calendar-changed",
    description: "Calendar window: JARVIS just moved “Booking call” to Fri 12:00; the log offers Undo.",
    data: {
      ...data,
      "/calendar": { ...week, events: [...week.events, booking] },
      "/calendar/log": { changes: [moved, ...changes] },
    },
    events: [{ after: 300, event: changed }],
    ui,
  },
  {
    name: "calendar-loading",
    description: "Calendar window: the worker is still fetching the week (loading skeleton).",
    data: { "/calendar": PENDING, "/calendar/free": PENDING, "/calendar/log": { changes } },
    events: [],
    ui,
  },
  {
    name: "calendar-error",
    description: "Calendar window: the calendar couldn't be fetched (Try again).",
    data: { "/calendar/free": data["/calendar/free"], "/calendar/log": { changes } },
    events: [],
    ui,
  },
];

export default scenarios;

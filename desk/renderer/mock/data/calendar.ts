// Today's calendar (mockup: Calendar window, incl. the "Changed by JARVIS" log), and a week of
// events and free slots as GET /calendar?start=&end= returns them (JD-21; the window is JD-35).
import type { CalendarEvent, CalendarFreeResponse, CalendarResponse } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const at = (day: number, hm: string) => `2026-10-${day}T${hm}:00+01:00`;
const ev = (
  id: string,
  day: number,
  from: string,
  to: string,
  title: string,
  kind: CalendarEvent["kind"],
  extra: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  id,
  calendarId: kind === "work" ? "work" : "primary",
  start: at(day, from),
  end: at(day, to),
  allDay: false,
  title,
  kind,
  ...extra,
});

const week: CalendarEvent[] = [
  ev("w1", 12, "09:30", "09:45", "Standup", "work", { link: "https://meet.google.com/abc-defg-hij" }),
  ev("w2", 12, "10:00", "12:00", "Focus: onboarding copy", "focus"),
  ev("w3", 12, "14:00", "15:00", "Design review", "work", {
    attendees: [
      { name: "Priya", email: "priya@example.com", response: "accepted" },
      { name: "Sam", email: "sam@example.com", response: "tentative" },
    ],
  }),
  ev("w4", 13, "09:30", "09:45", "Standup", "work"),
  ev("w5", 13, "12:30", "13:30", "Lunch with Sam", "personal", { location: "Dishoom" }),
  ev("w6", 13, "18:00", "19:00", "Gym", "personal"),
  {
    id: "w7",
    calendarId: "primary",
    start: "2026-10-14",
    end: "2026-10-15",
    allDay: true,
    title: "Office day",
    kind: "personal",
  },
  ev("w8", 14, "09:30", "09:45", "Standup", "work"),
  ev("w9", 14, "11:00", "12:00", "Investor update", "work", { location: "Zoom" }),
  ev("w10", 15, "09:30", "09:45", "Standup", "work"),
  ev("w11", 15, "13:00", "16:00", "Deep work block", "focus"),
  ev("w12", 16, "09:30", "09:45", "Standup", "work"),
  ev("w13", 16, "16:00", "17:00", "Retro", "work"),
  ev("w14", 17, "10:00", "12:00", "Parkrun + brunch", "personal"),
];

const free = [
  { start: at(12, "09:45"), end: at(12, "10:00") },
  { start: at(12, "12:00"), end: at(12, "14:00") },
  { start: at(12, "15:00"), end: at(12, "18:00") },
  { start: at(13, "09:45"), end: at(13, "12:30") },
  { start: at(13, "13:30"), end: at(13, "18:00") },
  { start: at(14, "09:45"), end: at(14, "11:00") },
  { start: at(14, "12:00"), end: at(14, "18:00") },
  { start: at(15, "09:45"), end: at(15, "13:00") },
  { start: at(15, "16:00"), end: at(15, "18:00") },
  { start: at(16, "09:45"), end: at(16, "16:00") },
  { start: at(16, "17:00"), end: at(16, "18:00") },
].filter((f) => Date.parse(f.end) - Date.parse(f.start) >= 30 * 60_000);

const calendar: CalendarResponse = {
  range: { start: at(12, "00:00"), end: at(19, "00:00") },
  events: week,
  free,
  ageSeconds: 120,
};

const freeResponse: CalendarFreeResponse = {
  from: at(14, "08:00"),
  to: at(21, "00:00"),
  minMinutes: 30,
  slots: free.filter((f) => f.start >= at(14, "08:00")),
  ageSeconds: 120,
};

const part: ScenarioPart = {
  data: {
    "/calendar": calendar,
    "/calendar/free": freeResponse,
    "/calendar/today": {
      events: [
        { id: "e1", title: "Standup", start: "2026-10-14T09:30:00Z", end: "2026-10-14T09:45:00Z" },
        {
          id: "e2",
          title: "Lunch with Sam",
          start: "2026-10-14T12:30:00Z",
          end: "2026-10-14T13:30:00Z",
          location: "Dishoom",
        },
        {
          id: "e3",
          title: "Gym",
          start: "2026-10-14T18:00:00Z",
          end: "2026-10-14T19:00:00Z",
          changedByJarvis: true,
        },
      ],
      changes: [
        {
          at: "2026-10-14T08:02:00Z",
          summary: "Moved Gym from 17:00 to 18:00",
          eventId: "e3",
          undoable: true,
        },
      ],
    },
  },
};

export default part;

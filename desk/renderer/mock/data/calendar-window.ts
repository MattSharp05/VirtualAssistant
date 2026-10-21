// The Calendar window's "Changed by JARVIS" log (JD-35) as GET /calendar/log returns it (JD-14, JD-77).
import type { CalendarChange } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

export const changes: CalendarChange[] = [
  {
    id: "c2",
    at: "2026-10-13T07:02:00Z",
    tool: "update_event",
    input: { eventId: "w6", startTime: "2026-10-13T18:00:00" },
    result: "Updated Gym",
    before: "Gym, Tue 13 Oct 17:00–18:00",
    summary: "update_event: Gym → 2026-10-13T18:00:00",
  },
  {
    id: "c1",
    at: "2026-10-12T17:20:00Z",
    tool: "respond",
    input: { eventId: "w10", response: "accepted" },
    result: "Accepted",
    summary: "respond: Standup → accepted",
  },
];

const part: ScenarioPart = { data: { "/calendar/log": { changes } } };

export default part;

// GET /api/desk/calendar/log → the last 20 calendar changes JARVIS made (newest first).
import type { CalendarChange } from "@jarvis/shared";
import { calendarLogFor } from "../../calendarLog.js";
import type { DeskRoute } from "./index.js";

const route: DeskRoute = {
  method: "GET",
  path: "/calendar/log",
  handler: ({ ctx }): { changes: CalendarChange[] } => ({ changes: calendarLogFor(ctx.jarvis).recent(20) }),
};

export default route;

// The orb's mood and Do Not Disturb:
//   GET  /api/desk/mood              → { mood, reason, dnd }
//   POST /api/desk/dnd { on, until? } → { on, until? }   (notices still recorded, not sent to Telegram)
import type { DndState, MoodResponse } from "@jarvis/shared";
import { notifier } from "../../notify.js";
import { reportWatcherFor } from "../../notifyRules.js";
import { DeskHttpError, type DeskRoute } from "./index.js";

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/mood",
    handler: ({ ctx }): MoodResponse => {
      const watcher = reportWatcherFor(ctx.jarvis);
      const { mood, reason } = watcher?.mood ?? { mood: "green", reason: "all fine" };
      return { mood, reason, dnd: (watcher?.notifier ?? notifier).dnd };
    },
  },
  {
    method: "POST",
    path: "/dnd",
    handler: ({ body, ctx }): DndState => {
      const until = body.until === undefined || body.until === null || body.until === "" ? undefined : String(body.until);
      if (until && Number.isNaN(Date.parse(until))) throw new DeskHttpError(400, "until must be an ISO date-time");
      return (reportWatcherFor(ctx.jarvis)?.notifier ?? notifier).setDnd(body.on === true, until);
    },
  },
];

export default routes;

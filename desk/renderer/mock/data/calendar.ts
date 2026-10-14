// Today's calendar (mockup: Calendar window, incl. the "Changed by JARVIS" log).
import type { ScenarioPart } from "../types";

const part: ScenarioPart = {
  data: {
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

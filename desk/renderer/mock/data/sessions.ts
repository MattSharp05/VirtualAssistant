// Cloud sessions JARVIS tracks (mockup: Sessions window). Later tickets refine the shape.
import type { ScenarioPart } from "../types";

const part: ScenarioPart = {
  data: {
    "/sessions": [
      {
        id: "mk",
        title: "Mario Kart · orchestrator",
        state: "working",
        detail: "MK-74 in review, 2 builders running",
        lastActivityAt: "2026-10-14T09:12:00Z",
      },
      {
        id: "trip",
        title: "Trip planner · orchestrator",
        state: "waiting",
        detail: "Needs your answer: hotel budget?",
        lastActivityAt: "2026-10-14T08:40:00Z",
      },
      {
        id: "shapemint",
        title: "ShapeMint · builder",
        state: "idle",
        detail: "SM-12 merged ✅",
        lastActivityAt: "2026-10-14T07:05:00Z",
      },
    ],
  },
  events: [
    {
      after: 4000,
      event: {
        type: "notice",
        at: "2026-10-14T09:15:00Z",
        level: "info",
        title: "mk merged MK-74 ✅",
        body: "3/5 tickets in this batch",
      },
    },
  ],
};

export default part;

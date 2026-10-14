// JARVIS Tasks (mockup: To-do window): what JARVIS picked up from Slack, email, sessions and Notion QA.
import type { ScenarioPart } from "../types";

const part: ScenarioPart = {
  data: {
    "/tasks": [
      { id: "t1", title: "Answer trip: hotel budget", source: "session", due: "2026-10-14", done: false },
      {
        id: "t2",
        title: "Review onboarding copy for Priya",
        source: "slack",
        due: "2026-10-14",
        done: false,
      },
      { id: "t3", title: "QA batch 1 of JARVIS Desk", source: "notion", done: false },
      { id: "t4", title: "Reply to Sam about lunch", source: "email", done: true },
    ],
  },
};

export default part;

import type { Scenario } from "../types";

const scenario: Scenario = {
  name: "empty",
  description: "A fresh install: nothing tracked, no events.",
  data: {
    "/sessions": [],
    "/tasks": [],
    "/inbox": { email: [], slack: [] },
    "/calendar/today": { events: [], changes: [] },
  },
  events: [],
};

export default scenario;

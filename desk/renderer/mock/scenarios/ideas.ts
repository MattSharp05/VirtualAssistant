// The Ideas window (JD-73): seven ideas across three projects and Unsorted, some already acted on;
// the same with every action failing; and no ideas at all.
import type { IdeasResponse } from "@jarvis/shared";
import { ideaProjects, sampleIdeas } from "../data/ideas";
import { ideaRoutes } from "../ideaRoutes";
import type { Scenario } from "../types";

const scenarios: Scenario[] = [
  {
    name: "ideas",
    description:
      "Ideas: seven ideas across JARVIS Desk, Trip planner, mk and Unsorted; a few already turned into a to-do, a chat or a session.",
    data: { "/ideas": { ideas: sampleIdeas, projects: ideaProjects } satisfies IdeasResponse },
    events: [],
    routes: [ideaRoutes()],
  },
  {
    name: "ideas-error",
    description: "Ideas while the actions fail: Go shows an error line and the pop-up keeps its text.",
    data: { "/ideas": { ideas: sampleIdeas, projects: ideaProjects } satisfies IdeasResponse },
    events: [],
    routes: [ideaRoutes({ failActions: "JARVIS didn't answer (502 Bad Gateway)." })],
  },
  {
    name: "ideas-empty",
    description: "Ideas with nothing captured yet: the writing box is ready for the first one.",
    data: { "/ideas": { ideas: [], projects: ideaProjects } satisfies IdeasResponse },
    events: [],
    routes: [ideaRoutes()],
  },
];

export default scenarios;

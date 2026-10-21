// Ideas as the Ideas window shows them (JD-73): a few per project and two unsorted, dated relative to
// the preview day, with the mock ideas routes so capture, edits and the three actions work.
import type { DeskIdea, IdeaProject, IdeasResponse } from "@jarvis/shared";
import { ideaRoutes } from "../ideaRoutes";
import { mockDay } from "../taskRoutes";
import type { ScenarioPart } from "../types";

const at = (day: number, time: string) => new Date(`${mockDay(day)}T${time}`).toISOString();

export const ideaProjects: IdeaProject[] = [
  { slug: "jarvis", name: "JARVIS Desk" },
  { slug: "trip", name: "Trip planner" },
  { slug: "mk", name: "mk" },
];

const idea = (
  id: string,
  text: string,
  project: string | undefined,
  created: string,
  history: DeskIdea["history"] = [],
): DeskIdea => ({
  id,
  text,
  ...(project ? { project } : {}),
  createdAt: created,
  updatedAt: created,
  history,
});

export const sampleIdeas: DeskIdea[] = [
  idea(
    "voice",
    "Voice notes straight into Ideas.\n\n“JARVIS, idea: …” after the wake word drops it here instead of chat, tagged by saying the project name.",
    "jarvis",
    at(0, "08:12:00"),
    [
      { kind: "todo", at: at(0, "08:14:00") },
      { kind: "chat", at: at(0, "08:20:00") },
    ],
  ),
  idea(
    "ring",
    "Orb shows a ring per running builder, so I can see how busy the agents are without opening anything.",
    "jarvis",
    at(-1, "17:40:00"),
  ),
  idea(
    "digest",
    "Weekly cost digest in Today\n\nIn the Today window: spend per project, biggest sessions, trend vs last week.",
    "jarvis",
    at(-4, "10:05:00"),
    [
      {
        kind: "session",
        at: at(-4, "10:30:00"),
        link: "https://claude.ai/code/session_01DIGEST",
        label: "design-digest",
      },
    ],
  ),
  idea("flights", "Auto-hold flights when Sam confirms dates in email.", "trip", at(-5, "12:00:00")),
  idea(
    "drift",
    "Drift boost A/B on staging first\n\nRun the drift boost as an A/B on staging before deciding.",
    "mk",
    at(-6, "15:20:00"),
    [{ kind: "chat", at: at(-6, "15:30:00") }],
  ),
  idea("slack", "Read-later queue from Slack saves.", undefined, at(-8, "09:00:00")),
  idea(
    "hands",
    "Camera hands + slides?\n\nSomething with the camera hands and slides?",
    undefined,
    at(-10, "21:10:00"),
  ),
];

const part: ScenarioPart = {
  data: { "/ideas": { ideas: sampleIdeas, projects: ideaProjects } satisfies IdeasResponse },
  routes: [ideaRoutes()],
};

export default part;

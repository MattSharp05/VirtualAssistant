// The To-do window (JD-36; mockup 6): suggestions with their sources, open tasks across Today,
// Upcoming and By project, a few done; and the same list where every write fails (rollback + error).
import type { TaskItem, TasksResponse } from "@jarvis/shared";
import { doneTasks, openTasks } from "../data/todo";
import { MOCK_TASKS_URL, mockDay, taskRoutes } from "../taskRoutes";
import type { Scenario } from "../types";

const suggested: TaskItem[] = [
  {
    id: "s1",
    name: "Decide MK-81: keep drift boost (cap 1.2×) or cut",
    status: "Suggested",
    due: mockDay(0),
    project: "mk",
    source: "Session",
    sourceLink: "https://claude.ai/code/session_01MK81",
    why: "mk blocked at 08:41 and is waiting on you.",
    createdAt: `${mockDay(0)}T08:41:00Z`,
  },
  {
    id: "s2",
    name: "Pick a flight option for the trip",
    status: "Suggested",
    due: mockDay(3),
    project: "Trip",
    source: "Email",
    sourceLink: "https://mail.google.com/mail/u/0/#inbox/18f2b",
    why: "Sam asked for an answer by Friday.",
    createdAt: `${mockDay(0)}T07:55:00Z`,
  },
  {
    id: "s3",
    name: "Reply to Alex about the new logo",
    status: "Suggested",
    source: "Slack",
    sourceLink: "https://gogentic.slack.com/archives/D01/p1760428920",
    why: "DM at 08:02, unanswered.",
    createdAt: `${mockDay(0)}T08:02:00Z`,
  },
];

const data = (): Record<string, unknown> => ({
  "/tasks?view=project": { view: "project", tasks: openTasks, notionUrl: MOCK_TASKS_URL },
  "/tasks?view=done": { view: "done", tasks: doneTasks, notionUrl: MOCK_TASKS_URL },
  "/tasks?view=suggested": {
    view: "suggested",
    tasks: suggested,
    notionUrl: MOCK_TASKS_URL,
  } satisfies TasksResponse,
});

const scenarios: Scenario[] = [
  {
    name: "todo",
    description:
      "To-do: three suggestions from a session, email and Slack; tasks due today, overdue and later.",
    data: data(),
    events: [],
    routes: [taskRoutes()],
    chatReply: "Added it to JARVIS Tasks.",
  },
  {
    name: "todo-error",
    description: "To-do while Notion is failing: ticking, adding or accepting rolls back with an error line.",
    data: data(),
    events: [],
    routes: [taskRoutes({ failWrites: "Notion didn't answer (502 Bad Gateway)." })],
  },
];

export default scenarios;

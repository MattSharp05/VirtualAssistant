// JARVIS Tasks as the To-do window shows them (JD-36; mockup 6): open and done rows, due dates
// relative to the preview day, and the mock tasks routes so ticking, adding and accepting work.
import type { TaskItem, TasksResponse } from "@jarvis/shared";
import { MOCK_TASKS_URL, mockDay, taskRoutes } from "../taskRoutes";
import type { ScenarioPart } from "../types";

const at = (day: number, time = "08:00:00") => `${mockDay(day)}T${time}Z`;

export const openTasks: TaskItem[] = [
  {
    id: "t1",
    name: "QA trip batch 3 (6 tickets)",
    status: "Open",
    due: mockDay(-1),
    project: "Trip",
    source: "Notion QA",
    createdAt: at(-3),
  },
  {
    id: "t2",
    name: "Review shapemint build failure",
    status: "Open",
    due: mockDay(0),
    project: "Shapemint",
    priority: "P1",
    source: "Email",
    createdAt: at(-1),
  },
  {
    id: "t3",
    name: "Call the bank about the card limit",
    status: "Open",
    due: `${mockDay(0)}T16:30:00`,
    project: "Personal",
    source: "You",
    createdAt: at(-1, "18:20:00"),
  },
  {
    id: "t4",
    name: "Confirm Friday booking call with Sam",
    status: "Open",
    due: mockDay(2),
    project: "Trip",
    source: "Slack",
    createdAt: at(-1, "11:02:00"),
  },
  {
    id: "t5",
    name: "Approve JARVIS Desk PRD",
    status: "Open",
    due: mockDay(2),
    project: "JARVIS Desk",
    source: "Session",
    createdAt: at(-2),
  },
  {
    id: "t6",
    name: "Renew passport",
    status: "Open",
    due: mockDay(12),
    project: "Personal",
    priority: "P2",
    source: "You",
    createdAt: at(-6),
  },
  { id: "t7", name: "Read the Trip PRD comments", status: "Open", source: "You", createdAt: at(-2) },
];

export const doneTasks: TaskItem[] = [
  {
    id: "t8",
    name: "Reply to Sam about lunch",
    status: "Done",
    due: mockDay(0),
    source: "Email",
    createdAt: at(-1, "09:00:00"),
  },
  {
    id: "t9",
    name: "Merge MK-74 after review",
    status: "Done",
    project: "mk",
    source: "Session",
    createdAt: at(-2, "15:40:00"),
  },
];

const response = (view: TasksResponse["view"], tasks: TaskItem[]): TasksResponse => ({
  view,
  tasks,
  notionUrl: MOCK_TASKS_URL,
});

const part: ScenarioPart = {
  data: {
    "/tasks?view=project": response("project", openTasks),
    "/tasks?view=done": response("done", doneTasks),
  },
  routes: [taskRoutes()],
};

export default part;

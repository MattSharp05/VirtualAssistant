// Browser tasks (JD-60), for the preview, e2e and snapshots: JARVIS booking a table at Taberna da Rua
// in the Browser window. Normal mode waiting on Matthew's OK to book (the question band, and its card
// beside the orb); Full autonomy working on its own (Pause / Stop, no questions); and the password
// stop, where Matthew takes over to sign in and hands back. Each has the History menu's past tasks;
// browser-task-history has only finished ones, each deletable for good from History (JD-67).
// JD-65: the ask box as the window's centrepiece (no page, no task), and a task running with its
// sidebar closed (the status line's pill brings it back).
import type { BrowserState, BrowserTask } from "@jarvis/shared";
import { browserTaskRoutes, pastTasks, questionNotice, tasksData } from "../browserTasks";
import type { Scenario } from "../types";

const NOW = "2026-10-22T18:52:00Z";
const URL = "https://reservas.example/taberna-da-rua";

const page = (status: string): BrowserState => ({
  tabs: [{ id: "tab-1", url: URL, title: "Book a table · Taberna da Rua", active: true }],
  url: URL,
  title: "Book a table · Taberna da Rua",
  canGoBack: true,
  canGoForward: false,
  loading: false,
  control: "jarvis",
  status,
});

const startLog = (mode: "Normal" | "Full autonomy", text: string) => [
  { at: "2026-10-22T18:49:30Z", kind: "start" as const, text: `${mode}: ${text}` },
  { at: "2026-10-22T18:49:40Z", kind: "action" as const, text: "Opening Taberna da Rua", url: URL },
  {
    at: "2026-10-22T18:50:20Z",
    kind: "action" as const,
    text: "Choosing 2 people, Fri 23 Oct, 20:00",
    url: URL,
  },
  { at: "2026-10-22T18:51:05Z", kind: "action" as const, text: "Checking availability", url: URL },
];

const normal: BrowserTask = {
  id: "task-taberna",
  text: "Book a table at Taberna da Rua for Friday 8pm for 2",
  mode: "normal",
  status: "waiting",
  origin: "desk-voice",
  startedAt: "2026-10-22T18:49:30Z",
  step: "Waiting for you: OK to book?",
  question: {
    id: "q-book",
    kind: "approval",
    text: "Book Taberna da Rua for 2 on Fri 23 Oct at 20:00? Table by the window, no deposit.",
    at: "2026-10-22T18:51:40Z",
  },
  steps: 5,
  log: [
    ...startLog("Normal", "Book a table at Taberna da Rua for Friday 8pm for 2"),
    {
      at: "2026-10-22T18:51:40Z",
      kind: "ask",
      text: "Book Taberna da Rua for 2 on Fri 23 Oct at 20:00? Table by the window, no deposit.",
      url: URL,
    },
  ],
};

const full: BrowserTask = {
  ...normal,
  id: "task-taberna-full",
  text: "Book a table at Taberna da Rua for Friday 8pm for 2, do it on your own",
  mode: "full",
  status: "running",
  origin: "desk-typed",
  step: "Booking the table",
  steps: 4,
  log: startLog("Full autonomy", "Book a table at Taberna da Rua for Friday 8pm for 2, do it on your own"),
};
delete full.question;

const password: BrowserTask = {
  ...normal,
  id: "task-taberna-signin",
  text: "Book a table at Taberna da Rua for Friday 8pm for 2 with my account",
  question: {
    id: "q-password",
    kind: "takeover",
    text: "The page on reservas.example asks for a password. Take over, type it yourself, then Hand back.",
    at: "2026-10-22T18:51:40Z",
  },
  step: "Waiting for you: sign in",
  log: [
    ...startLog("Normal", "Book a table at Taberna da Rua for Friday 8pm for 2 with my account"),
    {
      at: "2026-10-22T18:51:40Z",
      kind: "refused",
      text: "Stopped at a field Matthew types himself (a password)",
      url: URL,
    },
  ],
};

const scenario = (
  name: string,
  description: string,
  current: BrowserTask,
  status: string,
  ui: Scenario["ui"] = {},
): Scenario => {
  const notice = questionNotice(current);
  return {
    name,
    description,
    data: tasksData([current, ...pastTasks]),
    events: notice ? [{ after: 100, event: notice }] : [],
    routes: [browserTaskRoutes],
    browser: page(status),
    ui: { now: NOW, ...ui },
  };
};

const scenarios: Scenario[] = [
  scenario(
    "browser-task-normal",
    "Browser task, Normal mode: JARVIS wants an OK before booking the table: the question band (Approve / Change / Stop) and its card beside the orb.",
    normal,
    "Waiting for you · Book Taberna da Rua for 2 on Fri 23 Oct at 20:00?",
  ),
  scenario(
    "browser-task-full",
    "Browser task, Full autonomy: JARVIS books the table on its own; the sidebar's log, Pause and Stop, no questions.",
    full,
    "Booking the table",
  ),
  scenario(
    "browser-task-sidebar-closed",
    "Browser task running with its sidebar closed: the page gets the width, the task carries on, and the status line's pill reopens the log.",
    full,
    "Booking the table",
    { taskPanelClosed: true },
  ),
  {
    name: "browser-ask",
    description:
      "Browser with no page and no task: the ask box is the window's centrepiece; Start moves it into the task sidebar.",
    data: tasksData(pastTasks),
    events: [],
    routes: [browserTaskRoutes],
    ui: { now: NOW },
  },
  scenario(
    "browser-task-password-stop",
    "Browser task: stopped at a password field in either mode; Take over, type it, Hand back.",
    password,
    "Waiting for you · The page asks for a password",
  ),
  {
    name: "browser-task-history",
    description:
      "Browser task History with only finished tasks: open History, pick one, the trash button, then Delete for good.",
    data: tasksData(pastTasks),
    events: [],
    routes: [browserTaskRoutes],
    browser: page("Ready"),
    ui: { now: NOW },
  },
];

export default scenarios;

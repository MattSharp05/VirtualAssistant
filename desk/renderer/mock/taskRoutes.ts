// JARVIS Tasks in the mock bridge (JD-36): the To-do window's reads and writes against an in-memory
// list, like src/desk/routes/tasks.ts does against Notion. The list starts as every task in the
// scenario's static `/tasks?view=…` responses; writes change it and publish tasks.changed.
// JD-83 adds the Chat/Session actions (mirroring ideaRoutes.ts) and the QA checklist read.
import type {
  AcceptAllResponse,
  TaskActionResponse,
  TaskItem,
  TaskQaResponse,
  TasksResponse,
  TaskView,
} from "@jarvis/shared";
import type { MockRoute } from "./types";

export const MOCK_TASKS_URL = "https://www.notion.so/JARVIS-Tasks";

/** A stand-in Acceptance Criteria checklist for any Notion QA to-do in the mock (JD-83). */
const QA_CHECKLIST: TaskQaResponse["checklist"] = [
  { text: "Cancelling inside 24h shows the correct refund amount", checked: true },
  { text: "The confirmation email links back to the booking", checked: true },
  { text: "A second cancellation attempt is blocked with a clear message", checked: false },
];

const VIEWS: TaskView[] = ["today", "upcoming", "project", "done", "suggested"];
const STORE = "mock:tasks";

/** YYYY-MM-DD `offset` days from today (local), so scenario dates stay relative to the preview day. */
export function mockDay(offset: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function store(data: Record<string, unknown>): TaskItem[] {
  if (!data[STORE]) {
    const seen = new Map<string, TaskItem>();
    for (const view of VIEWS)
      for (const t of (data[`/tasks?view=${view}`] as TasksResponse | undefined)?.tasks ?? [])
        if (!seen.has(t.id)) seen.set(t.id, t);
    data[STORE] = [...seen.values()];
  }
  return data[STORE] as TaskItem[];
}

function view(all: TaskItem[], view: TaskView): TaskItem[] {
  const today = mockDay(0);
  const open = all.filter((t) => t.status === "Open");
  const due = (t: TaskItem) => t.due?.slice(0, 10);
  switch (view) {
    case "today":
      return open.filter((t) => t.due && due(t)! <= today);
    case "upcoming":
      return open.filter((t) => !t.due || due(t)! > today);
    case "project":
      return open;
    case "done":
      return all.filter((t) => t.status === "Done");
    case "suggested":
      return all.filter((t) => t.status === "Suggested");
  }
}

const STATUS = { done: "Done", reopen: "Open", accept: "Open", dismiss: "Dismissed" } as const;

/** The tasks routes; with `failWrites`, every write fails with that message (nothing changes). */
export function taskRoutes(opts: { failWrites?: string } = {}): MockRoute {
  let added = 0;
  let jobs = 60;
  return (path, body, { data, emit }) => {
    if (!path.startsWith("/tasks")) return undefined;
    const viewMatch = /^\/tasks\?view=(\w+)$/.exec(path);
    if (viewMatch) {
      const v = viewMatch[1] as TaskView;
      if (!VIEWS.includes(v) || !(VIEWS.some((x) => `/tasks?view=${x}` in data) || data[STORE]))
        return undefined;
      return { view: v, tasks: view(store(data), v), notionUrl: MOCK_TASKS_URL } satisfies TasksResponse;
    }
    const qaMatch = /^\/tasks\/([^/]+)\/qa$/.exec(path);
    if (qaMatch) {
      const task = store(data).find((t) => t.id === decodeURIComponent(qaMatch[1]!));
      if (!task) throw new Error(`No task ${qaMatch[1]}`);
      if (task.source !== "Notion QA" || !task.sourceLink)
        throw new Error("This task has no Notion QA page.");
      return { checklist: QA_CHECKLIST } satisfies TaskQaResponse;
    }
    if (body === undefined) return undefined;
    if (opts.failWrites) throw new Error(opts.failWrites);
    const all = store(data);
    const changed = () => emit({ type: "tasks.changed" });
    if (path === "/tasks") {
      const { name = "", due, project } = body as { name?: string; due?: string; project?: string };
      if (!name.trim()) throw new Error("A task needs a name.");
      const task: TaskItem = {
        id: `mock-task-${++added}`,
        name: name.trim(),
        status: "Open",
        source: "You",
        createdAt: new Date().toISOString(),
        ...(due ? { due } : {}),
        ...(project ? { project } : {}),
      };
      all.push(task);
      changed();
      return task;
    }
    if (path === "/tasks/accept-all") {
      const accepted = all.filter((t) => t.status === "Suggested");
      for (const t of accepted) t.status = "Open";
      changed();
      return { accepted } satisfies AcceptAllResponse;
    }
    const action = /^\/tasks\/([^/]+)\/(done|reopen|accept|dismiss|chat|session)$/.exec(path);
    if (!action) return undefined;
    const task = all.find((t) => t.id === action[1]);
    if (!task) throw new Error(`No task ${action[1]}`);
    const kind = action[2]!;
    if (kind === "chat" || kind === "session") {
      const now = new Date().toISOString();
      task.history = task.history ?? [];
      const out: Omit<TaskActionResponse, "task"> = {};
      if (kind === "chat") {
        out.messageId = `mock-task-chat-${task.id}`;
        task.history.push({ kind, at: now });
      } else {
        const name = `j${++jobs}`;
        const url = `https://claude.ai/code/session_01TASK${jobs}`;
        out.session = { name, url };
        task.history.push({ kind, at: now, link: url, label: name });
      }
      changed();
      return { task, ...out } satisfies TaskActionResponse;
    }
    task.status = STATUS[kind as keyof typeof STATUS];
    delete task.why;
    changed();
    return task;
  };
}

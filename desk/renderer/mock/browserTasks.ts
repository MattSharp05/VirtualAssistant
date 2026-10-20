// Browser tasks in the mock bridge (JD-60): a history of tasks with their logs, and the routes the
// Browser window's task strip and the question cards call (start, pause, resume, stop, answer), each
// answered as the server would (src/browser/tasks.ts) and followed by a browser.task event. History's
// delete (JD-67) drops a finished task from the bridge's copy.
import type {
  BrowserTask,
  BrowserTaskMode,
  BrowserTaskResultItem,
  BrowserTaskStep,
  BrowserTaskSummary,
  BrowserTasksResponse,
  DeskEvent,
  NoticeAction,
} from "@jarvis/shared";
import type { MockRoute } from "./types";

/** Where the routes keep the tasks (with logs) in the bridge's data. */
export const TASKS_KEY = "/browser/tasks";

const step = (at: string, kind: BrowserTaskStep["kind"], text: string, url?: string): BrowserTaskStep => ({
  at,
  kind,
  text,
  ...(url ? { url } : {}),
});

/** A finished task for the History menu. */
export function task(
  id: string,
  text: string,
  status: BrowserTask["status"],
  startedAt: string,
  log: BrowserTaskStep[],
  extra: Partial<BrowserTask> = {},
): BrowserTask {
  return {
    id,
    text,
    mode: "normal",
    status,
    origin: "desk-voice",
    startedAt,
    ...(log.length ? { endedAt: log[log.length - 1]!.at } : {}),
    steps: log.length,
    log,
    ...extra,
  };
}

/** The last few days' tasks, newest first (the History menu in every browser-task scenario and demo-day). */
export const pastTasks: BrowserTask[] = [
  task(
    "task-flights",
    "Find the cheapest flight to Lisbon in March and put the options in a card",
    "done",
    "2026-10-21T08:12:00Z",
    [
      step("2026-10-21T08:12:00Z", "start", "Normal: Find the cheapest flight to Lisbon in March…"),
      step(
        "2026-10-21T08:12:20Z",
        "action",
        "Searching flights LHR → LIS in March",
        "https://flights.example/search",
      ),
      step("2026-10-21T08:13:05Z", "action", "Sorting by price", "https://flights.example/results"),
      step(
        "2026-10-21T08:14:10Z",
        "done",
        "Cheapest: 4 Mar £48 (07:10), 11 Mar £52, 18 Mar £61. Nothing booked.",
      ),
    ],
    { result: "Cheapest: 4 Mar £48 (07:10), 11 Mar £52, 18 Mar £61. Nothing booked.", origin: "telegram" },
  ),
  task(
    "task-permit",
    "Renew the parking permit for the car",
    "done",
    "2026-10-19T17:40:00Z",
    [
      step("2026-10-19T17:40:00Z", "start", "Normal: Renew the parking permit for the car"),
      step(
        "2026-10-19T17:40:30Z",
        "action",
        "Opening the council's permits page",
        "https://permits.example/renew",
      ),
      step(
        "2026-10-19T17:41:10Z",
        "refused",
        "Stopped at a field Matthew types himself (a password)",
        "https://permits.example/login",
      ),
      step(
        "2026-10-19T17:41:10Z",
        "ask",
        "The page on permits.example asks for a password. Take over, type it yourself, then Hand back.",
      ),
      step("2026-10-19T17:42:30Z", "resume", "Matthew handed the browser back"),
      step(
        "2026-10-19T17:43:00Z",
        "ask",
        "OK to click ‘Pay £45’ on permits.example? (Paying for the 12-month permit)",
      ),
      step("2026-10-19T17:43:20Z", "approval", "Matthew approved: OK to click ‘Pay £45’ on permits.example?"),
      step(
        "2026-10-19T17:43:22Z",
        "approval",
        "Used Matthew's approval: Paying for the 12-month permit",
        "https://permits.example/pay",
      ),
      step("2026-10-19T17:43:40Z", "done", "Renewed until 19 Oct 2027 (£45, ref PRM-55120)."),
    ],
    { result: "Renewed until 19 Oct 2027 (£45, ref PRM-55120).", origin: "browser" },
  ),
  task(
    "task-newsletter",
    "Unsubscribe me from the Fitwell newsletter",
    "stopped",
    "2026-10-18T10:05:00Z",
    [
      step("2026-10-18T10:05:00Z", "start", "Full autonomy: Unsubscribe me from the Fitwell newsletter"),
      step(
        "2026-10-18T10:05:40Z",
        "action",
        "Opening the email preferences",
        "https://fitwell.example/prefs",
      ),
      step("2026-10-18T10:06:10Z", "stop", "Stopped by Matthew."),
    ],
    { mode: "full", result: "Stopped by Matthew.", origin: "desk-typed" },
  ),
];

function summary(t: BrowserTask): BrowserTaskSummary {
  const copy: Partial<BrowserTask> = { ...t };
  delete copy.log;
  return copy as BrowserTaskSummary;
}

/** The bridge's data for a scenario whose tasks are `tasks` (newest first). */
export function tasksData(tasks: BrowserTask[]): Record<string, unknown> {
  return { [TASKS_KEY]: tasks };
}

/** The card a waiting task's question puts beside the orb (as the server's notice). */
export function questionNotice(t: BrowserTask): DeskEvent | undefined {
  const q = t.question;
  if (!q) return undefined;
  const path = `/browser/tasks/${t.id}/answer`;
  const stop: NoticeAction = { label: "Stop", request: { path, body: { questionId: q.id, answer: "stop" } } };
  return {
    type: "notice",
    id: `browser-task-${t.id}-question`,
    at: q.at,
    level: q.kind === "question" ? "info" : "warn",
    title:
      q.kind === "approval"
        ? "JARVIS needs your OK"
        : q.kind === "takeover"
          ? "Over to you in the browser"
          : "JARVIS has a question",
    body: q.text,
    actions:
      q.kind === "approval"
        ? [
            { label: "Approve", request: { path, body: { questionId: q.id, answer: "approve" } } },
            { label: "Change", window: "browser" },
            stop,
          ]
        : [{ label: q.kind === "takeover" ? "Open browser" : "Answer", window: "browser" }, stop],
  };
}

const FULL = /on your own|full autonomy|without asking/i;
const TASK = /^\/browser\/tasks\/([^/]+)(?:\/(pause|resume|stop|answer|followup|delete))?$/;

/** How long the mock's follow-up takes to answer (JD-66). */
export const FOLLOW_UP_MS = 600;

/** The mock browser brain's answer to a follow-up: adds a to-do, or reads the result again. */
function followUpAnswer(text: string, item?: BrowserTaskResultItem): string {
  const what = item ? `${item.label}${item.detail ? `, ${item.detail}` : ""}` : "the results";
  if (/to-?do|task|remind/i.test(text)) return `Added “Book: ${what}” to your to-do list.`;
  if (!item?.url)
    return `${item ? `“${item.label}” isn't one page yet` : "Those are the options I found"}: I can search that day directly if you want a real itinerary.`;
  return `Checked ${host(item.url)} again: ${what} has 2 stops (Toronto, then Istanbul), 44h 20m in all.`;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** GET /browser/tasks(/:id) and the writes, on the bridge's own copy of the tasks. */
export const browserTaskRoutes: MockRoute = (path, body, { data, emit }) => {
  if (path !== TASKS_KEY && !TASK.test(path)) return undefined;
  const tasks = (data[TASKS_KEY] as BrowserTask[] | undefined) ?? [];
  const at = new Date().toISOString();
  const save = (t: BrowserTask) => {
    data[TASKS_KEY] = [t, ...tasks.filter((x) => x.id !== t.id)];
    emit({ type: "browser.task", task: summary(t) });
    return summary(t);
  };
  if (path === TASKS_KEY) {
    if (body === undefined) return { tasks: tasks.map(summary) } satisfies BrowserTasksResponse;
    const { text = "", mode } = body as { text?: string; mode?: BrowserTaskMode };
    if (tasks.some((t) => ["running", "waiting", "paused"].includes(t.status)))
      throw new Error("A browser task is already running. Stop it first, or wait for it.");
    const chosen: BrowserTaskMode = mode === "full" || FULL.test(text) ? "full" : "normal";
    return save({
      id: `task-${tasks.length + 1}`,
      text,
      mode: chosen,
      status: "running",
      origin: "browser",
      startedAt: at,
      step: "Starting",
      steps: 1,
      log: [step(at, "start", `${chosen === "full" ? "Full autonomy" : "Normal"}: ${text}`)],
    });
  }
  const [, id, action] = TASK.exec(path)!;
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error(`No browser task ${id}.`);
  if (!action) return t;
  if (action === "delete") {
    if (["running", "waiting", "paused"].includes(t.status))
      throw new Error(`The task is ${t.status}. Stop it first, then delete it.`);
    data[TASKS_KEY] = tasks.filter((x) => x.id !== id);
    return { tasks: tasks.filter((x) => x.id !== id).map(summary) } satisfies BrowserTasksResponse;
  }
  const rest: BrowserTask = { ...t };
  delete rest.question;
  const running = (s: string, kind: BrowserTaskStep["kind"], line: string): BrowserTask => ({
    ...rest,
    status: "running",
    step: s,
    log: [...t.log, step(at, kind, line)],
    steps: t.steps + 1,
  });
  const ended = (): BrowserTask => ({
    ...rest,
    status: "stopped",
    endedAt: at,
    result: "Stopped by Matthew.",
    log: [...t.log, step(at, "stop", "Stopped by Matthew.")],
    steps: t.steps + 1,
  });
  if (action === "stop") return save(ended());
  if (action === "pause")
    return save({
      ...t,
      status: "paused",
      step: "Paused",
      log: [...t.log, step(at, "pause", "Paused by Matthew")],
      steps: t.steps + 1,
    });
  if (action === "resume") {
    if (t.status === "paused") return save(running("Carrying on", "resume", "Resumed by Matthew"));
    if (t.status === "waiting" && t.question?.kind === "takeover")
      return save(running("Carrying on", "resume", "Matthew handed the browser back"));
    return summary(t);
  }
  if (action === "followup") {
    const { text = "", item } = (body ?? {}) as { text?: string; item?: number };
    if (!text.trim()) throw new Error("Say what to do with it.");
    if (t.status !== "done")
      throw new Error("That task didn't finish, so it can't be picked up again. Start a new one.");
    if (tasks[0]?.id !== t.id)
      throw new Error(
        "Another browser task has started since, so this one can't be picked up again. Start a new one.",
      );
    const picked = item === undefined ? undefined : t.results?.items[item];
    const asked = step(
      at,
      "answer",
      `Matthew followed up${picked ? ` on “${picked.label}”` : ""}: ${text}`,
      picked?.url,
    );
    const reopened: BrowserTask = {
      ...rest,
      status: "running",
      step: "Following up",
      log: [...t.log, asked],
      steps: t.steps + 1,
    };
    delete reopened.endedAt;
    // The answer comes a moment later, like the browser brain's turn.
    setTimeout(() => {
      const now = (data[TASKS_KEY] as BrowserTask[] | undefined) ?? [];
      const current = now.find((x) => x.id === t.id);
      if (current?.status !== "running") return;
      const result = followUpAnswer(text, picked);
      const done: BrowserTask = {
        ...current,
        status: "done",
        endedAt: new Date().toISOString(),
        result,
        log: [...current.log, step(new Date().toISOString(), "done", result)],
        steps: current.steps + 1,
      };
      delete done.step;
      data[TASKS_KEY] = [done, ...now.filter((x) => x.id !== t.id)];
      emit({ type: "browser.task", task: summary(done) });
    }, FOLLOW_UP_MS);
    return save(reopened);
  }
  const { answer, text } = (body ?? {}) as { answer?: string; text?: string };
  if (answer === "stop") return save(ended());
  if (answer === "approve")
    return save(running("Booking the table", "approval", `Matthew approved: ${t.question?.text ?? ""}`));
  if (answer === "change")
    return save(running(`Changing it: ${text ?? ""}`, "answer", `Matthew wants a change: ${text ?? ""}`));
  return save(running("Carrying on", "answer", `Matthew answered: ${text ?? ""}`));
};

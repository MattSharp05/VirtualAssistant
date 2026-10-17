// Browser tasks in the Browser window (JD-60): the pure bits of the task strip, its question and the
// History menu. Tasks come from GET /browser/tasks and browser.task events (newest first).
import type { BrowserTaskStatus, BrowserTaskStep, BrowserTaskSummary } from "@jarvis/shared";

/** A finished task stays on the strip (its result) this long, then the box is ready for the next. */
export const SHOW_ENDED_MS = 30 * 60_000;

const ACTIVE: BrowserTaskStatus[] = ["running", "waiting", "paused"];

export const isActive = (t: BrowserTaskSummary | undefined): boolean => !!t && ACTIVE.includes(t.status);

/** The list with `task` in it (replacing its old self), newest first. */
export function upsertTask(tasks: BrowserTaskSummary[], task: BrowserTaskSummary): BrowserTaskSummary[] {
  const rest = tasks.filter((t) => t.id !== task.id);
  return [task, ...rest].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/**
 * What the strip shows: the task going on, else the last one when it ended a moment ago, or while this
 * window watched it run (`followed`) — until Matthew clears it with New task.
 */
export function shownTask(
  tasks: BrowserTaskSummary[],
  now: number,
  cleared?: string,
  followed?: string,
): BrowserTaskSummary | undefined {
  const active = tasks.find(isActive);
  if (active) return active;
  const last = tasks[0];
  if (!last || last.id === cleared) return undefined;
  if (last.id === followed) return last;
  // A minute's leeway for the server's clock; anything "later" than that is another clock's data.
  const ago = now - Date.parse(last.endedAt ?? last.startedAt);
  return ago > -60_000 && ago < SHOW_ENDED_MS ? last : undefined;
}

const STATE: Record<BrowserTaskStatus, string> = {
  running: "Working",
  waiting: "Waiting for you",
  paused: "Paused",
  done: "Done",
  stopped: "Stopped",
  failed: "Couldn't finish",
};

export const stateLabel = (status: BrowserTaskStatus): string => STATE[status];

export const modeLabel = (mode: BrowserTaskSummary["mode"]): string =>
  mode === "full" ? "Full autonomy" : "Normal";

/** The question's heading, by kind. */
export function questionTitle(kind: "approval" | "question" | "takeover"): string {
  if (kind === "approval") return "JARVIS needs your OK";
  if (kind === "takeover") return "Over to you";
  return "JARVIS has a question";
}

const STEP: Record<BrowserTaskStep["kind"], string> = {
  start: "Asked",
  action: "Step",
  ask: "Asked you",
  answer: "You said",
  approval: "Approval",
  refused: "Stopped",
  pause: "Paused",
  resume: "Resumed",
  done: "Done",
  stop: "Stopped",
  error: "Failed",
};

export const stepLabel = (kind: BrowserTaskStep["kind"]): string => STEP[kind];

const pad = (n: number) => String(n).padStart(2, "0");

/** "Today 09:12", "Yesterday 18:40", or "Thu 15 Oct 18:40", in the Mac's time zone. */
export function when(iso: string, now: number): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${date.replace(",", "")} ${time}`;
}

/** "09:12" for a log line. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A URL's host, for log lines. */
export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

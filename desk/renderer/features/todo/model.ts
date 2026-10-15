// The To-do window's logic (JD-36), kept free of React: which tab a task belongs in (the server's
// rules from src/tasks.ts, worked out here so optimistic changes land in the right tab at once), how
// a due date reads, and whether typed text has a date in it (then JARVIS adds it, not the window).
import type { TaskItem } from "@jarvis/shared";

export type Tab = "today" | "upcoming" | "project" | "done";

export const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "project", label: "By project" },
  { id: "done", label: "Done" },
];

/** YYYY-MM-DD in local time. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dueDay = (t: TaskItem) => t.due?.slice(0, 10);
const byDue = (a: TaskItem, b: TaskItem) =>
  (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? "P9").localeCompare(b.priority ?? "P9");

/** The tasks a tab lists, in order (By project: grouped by project, no project last). */
export function tabTasks(all: TaskItem[], tab: Tab, today: string): TaskItem[] {
  const open = all.filter((t) => t.status === "Open");
  switch (tab) {
    case "today":
      return open.filter((t) => t.due && dueDay(t)! <= today).sort(byDue);
    case "upcoming":
      return open.filter((t) => !t.due || dueDay(t)! > today).sort(byDue);
    case "project":
      return [...open].sort(
        (a, b) =>
          Number(!a.project) - Number(!b.project) ||
          (a.project ?? "").localeCompare(b.project ?? "") ||
          byDue(a, b),
      );
    case "done":
      return all.filter((t) => t.status === "Done").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function suggestions(all: TaskItem[]): TaskItem[] {
  return all.filter((t) => t.status === "Suggested").sort(byDue);
}

/** Consecutive runs of the By project list under their project's name. */
export function groupByProject(tasks: TaskItem[]): { project: string; tasks: TaskItem[] }[] {
  const groups: { project: string; tasks: TaskItem[] }[] = [];
  for (const t of tasks) {
    const project = t.project ?? "No project";
    const last = groups.at(-1);
    if (last?.project === project) last.tasks.push(t);
    else groups.push({ project, tasks: [t] });
  }
  return groups;
}

export function isOverdue(t: TaskItem, today: string): boolean {
  return t.status === "Open" && !!t.due && dueDay(t)! < today;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today", "tomorrow", "yesterday", "Fri" (this week), else "Oct 21"; a time when it has one. */
export function dueLabel(due: string, today: string): string {
  const [y, m, d] = due.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const days = Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(ty!, tm! - 1, td!)) / 86_400_000);
  const date = new Date(y!, m! - 1, d!);
  const day =
    days === 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : days === -1
          ? "yesterday"
          : days > 1 && days < 7
            ? WEEKDAYS[date.getDay()]!
            : `${MONTHS[m! - 1]} ${d}`;
  const time = /T(\d{2}:\d{2})/.exec(due)?.[1];
  return time ? `${day} ${time}` : day;
}

/** One line for the header: "5 open · 2 overdue". */
export function summary(all: TaskItem[], today: string): string {
  const open = all.filter((t) => t.status === "Open");
  const overdue = open.filter((t) => isOverdue(t, today)).length;
  return `${open.length} open${overdue ? ` · ${overdue} overdue` : ""}`;
}

// Words and shapes that mean a date or time is in the text. Ambiguous short words (may, sat, sun,
// march) only count next to a number.
const MONTH =
  "jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?";
const DATE_PATTERNS = [
  /\b(today|tonight|tomorrow|tmrw|eod|eow|noon|midnight|weekend)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(rs?)?|fri)\b/i,
  /\b(next|this|every) (week|month|year|morning|afternoon|evening)\b/i,
  /\bend of (the )?(day|week|month)\b/i,
  new RegExp(`\\b(${MONTH})\\.? \\d{1,2}(st|nd|rd|th)?\\b`, "i"),
  new RegExp(`\\b\\d{1,2}(st|nd|rd|th)? (of )?(${MONTH})\\b`, "i"),
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  /\b\d{1,2}(:\d{2})? ?(am|pm)\b/i,
  /\b\d{1,2}:\d{2}\b/,
  /\bin (\d+|a|an|one|two|three|a few) (min(ute)?s?|hours?|days?|weeks?|months?)\b/i,
  /\bremind me\b/i,
];

/** True when the text names a date or time: JARVIS parses it ("add …") instead of a plain add. */
export function hasDate(text: string): boolean {
  return DATE_PATTERNS.some((re) => re.test(text));
}

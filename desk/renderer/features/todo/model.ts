// The To-do window's logic (JD-36), kept free of React: which tab a task belongs in (the server's
// rules from src/tasks.ts, worked out here so optimistic changes land in the right tab at once), how
// a due date reads, and whether typed text has a date in it (then JARVIS adds it, not the window).
// JD-83 adds: the QA badge, and row actions (Chat, Session) with the same pop-up state machine as the
// Ideas window (desk/renderer/features/ideas/model.ts) — duplicated, not imported: features don't
// cross-import (CLAUDE.md).
import type { TaskAction, TaskHistoryEntry, TaskItem } from "@jarvis/shared";

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

// ── QA (JD-83): a to-do sourced from Notion QA has a ticket page to show and link to ──

export function hasQa(task: TaskItem): boolean {
  return task.source === "Notion QA" && Boolean(task.sourceLink);
}

// ── Row actions (JD-83): mirrors the Ideas window's "Then" row, minus "todo" (the item already is one) ──

export const ACTIONS: { id: TaskAction; glyph: string; label: string; hint: string; placeholder: string }[] =
  [
    {
      id: "chat",
      glyph: "◌",
      label: "Chat with JARVIS",
      hint: "Opens Chat with this to-do as the first message.",
      placeholder: "What do you want to work out?",
    },
    {
      id: "session",
      glyph: "▷",
      label: "Start a session",
      hint: "A cloud session on the to-do's project repo.",
      placeholder: "Spike it, write a doc, build it…",
    },
  ];

export interface PopupState {
  hover: TaskAction | null;
  pinned: TaskAction | null;
  drafts: Partial<Record<TaskAction, string>>;
}

export const CLOSED: PopupState = { hover: null, pinned: null, drafts: {} };

const hasDraft = (s: PopupState, id: TaskAction) => Boolean(s.drafts[id]?.trim());

export const popup = {
  isOpen: (s: PopupState, id: TaskAction) =>
    s.pinned === id || (s.hover === id && (!s.pinned || s.pinned === id)),
  hasDraft,
  isPinned: (s: PopupState, id: TaskAction) => s.pinned === id,
  /** The pointer (or focus) arrives: opens it unless another holds a draft. */
  enter: (s: PopupState, id: TaskAction): PopupState =>
    !s.pinned || s.pinned === id ? { ...s, hover: id } : s,
  /** The pointer leaves the button and its pop-up. */
  leave: (s: PopupState, id: TaskAction): PopupState => (s.hover === id ? { ...s, hover: null } : s),
  /** A click on the button: opens this one (pinned if it has a draft); any other closes, its draft kept. */
  click: (s: PopupState, id: TaskAction): PopupState => ({
    ...s,
    hover: id,
    pinned: hasDraft(s, id) ? id : null,
  }),
  /** Typing in the context field: text pins it; clearing it unpins. */
  type: (s: PopupState, id: TaskAction, value: string): PopupState => ({
    drafts: { ...s.drafts, [id]: value },
    pinned: value.trim() ? id : s.pinned === id ? null : s.pinned,
    hover: value.trim() ? s.hover : id,
  }),
  /** Go / Enter went through: closed, its text gone. */
  sent: (s: PopupState, id: TaskAction): PopupState => ({
    hover: null,
    pinned: null,
    drafts: { ...s.drafts, [id]: "" },
  }),
  /** ✕: the draft is thrown away. */
  discard: (s: PopupState, id: TaskAction): PopupState => ({
    hover: null,
    pinned: null,
    drafts: { ...s.drafts, [id]: "" },
  }),
  /** Esc, or a click anywhere else: closed, drafts kept. */
  close: (s: PopupState): PopupState => (s.hover || s.pinned ? { ...s, hover: null, pinned: null } : s),
};

/** The pop-up's small print. */
export function popupFoot(draft: boolean): string {
  return draft ? "stays open until sent or you click away · ↵ to go" : "context is optional · ↵ to go";
}

const DAY_PAD = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const HISTORY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function historyDayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (dayKey(d) === dayKey(now)) return "today";
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "yesterday";
  return `${HISTORY_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const historyClock = (iso: string) => {
  const d = new Date(iso);
  return `${DAY_PAD(d.getHours())}:${DAY_PAD(d.getMinutes())}`;
};

const DONE: Record<TaskAction, string> = { chat: "Opened in Chat", session: "Session started" };

export interface HistoryPart {
  text: string;
  link?: string;
  title?: string;
}

/** One line under a row's actions: "Opened in Chat 08:14 · Session started Oct 16". */
export function historyParts(history: TaskHistoryEntry[] | undefined, now: Date): HistoryPart[] {
  return (history ?? []).map((h) => {
    const day = historyDayLabel(h.at, now);
    const when = day === "today" ? historyClock(h.at) : day;
    return {
      text: `${DONE[h.kind]} ${when}`.trim(),
      ...(h.link ? { link: h.link } : {}),
      ...(h.label ? { title: h.label } : {}),
    };
  });
}

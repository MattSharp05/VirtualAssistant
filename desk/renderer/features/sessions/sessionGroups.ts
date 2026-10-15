// The Sessions window's logic, kept out of the components so it's unit-tested on its own: the
// groups and their dots, the status pill, filtering and the short times.
import type { DeskSession, ReportKind, SessionActivityItem, SessionGroup } from "@jarvis/shared";

export const GROUPS: { id: SessionGroup; label: string }[] = [
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
];

/** red: blocked · amber: waits on a decision or QA · green: working · grey: idle. */
export type Tone = "red" | "amber" | "green" | "grey";

export function toneOf(s: Pick<DeskSession, "group" | "latestKind">): Tone {
  if (s.group === "needs-you") return s.latestKind === "blocked" ? "red" : "amber";
  return s.group === "working" ? "green" : "grey";
}

const NEEDS_YOU_PILL: Partial<Record<ReportKind, string>> = {
  blocked: "Blocked · needs you",
  decision: "Needs a decision",
  finished: "Ready for QA",
};

export function pillOf(s: Pick<DeskSession, "group" | "latestKind">): string {
  if (s.group === "needs-you") return (s.latestKind && NEEDS_YOU_PILL[s.latestKind]) ?? "Needs you";
  return s.group === "working" ? "Working" : "Idle";
}

/** What the list and the send button call a session: its tracked name, else its title. */
export const labelOf = (s: Pick<DeskSession, "name" | "title">): string => s.name ?? s.title;

export function matches(s: DeskSession, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return [s.name, s.title, s.latestReport, s.status].some((v) => v?.toLowerCase().includes(q));
}

/** The groups that have sessions after filtering, in order (the server already sorts within one). */
export function groupSessions(
  sessions: DeskSession[],
  filter = "",
): { id: SessionGroup; label: string; sessions: DeskSession[] }[] {
  return GROUPS.map((g) => ({
    ...g,
    sessions: sessions.filter((s) => s.group === g.id && matches(s, filter)),
  })).filter((g) => g.sessions.length > 0);
}

/** "now", "12m", "3h", "2d". */
export function ago(at: string | undefined, now = Date.now()): string {
  if (!at) return "";
  const min = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (24 * 60))}d`;
}

/** 08:41 in local time. */
export function clock(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Who an activity line is from: the session itself, a tool it used, or the person (or JARVIS) messaging it. */
export function whoOf(item: SessionActivityItem, label: string): string {
  if (item.role === "user") return "you";
  if (item.role === "tool") return "tool";
  return item.role === "assistant" ? label : "";
}

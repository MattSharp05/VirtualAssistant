// The Ideas window's logic (JD-73), kept pure so it's tested on its own: the sidebar's groups and
// lines, the history line, and the "Then" row's pop-ups (which one is open, which hold a draft).
import type { DeskIdea, IdeaAction, IdeaHistoryEntry, IdeaProject } from "@jarvis/shared";

export const UNSORTED = "Unsorted";

/** The three "Then" buttons, in order, with their pop-up's words (from the agreed sketch). */
export const ACTIONS: {
  id: IdeaAction;
  glyph: string;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    id: "todo",
    glyph: "☐",
    label: "Add to to-dos",
    hint: "Shows up in To-do suggestions, linked back here.",
    placeholder: "When, priority…",
  },
  {
    id: "chat",
    glyph: "◌",
    label: "Chat with JARVIS",
    hint: "Opens Chat with this idea as the first message.",
    placeholder: "What do you want to work out?",
  },
  {
    id: "session",
    glyph: "▷",
    label: "Start a session",
    hint: "A cloud session on the tagged project’s repo.",
    placeholder: "Spike it, write a doc, build it…",
  },
];

/** The idea's first non-empty line (its title in the sidebar). */
export function ideaTitle(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today", "yesterday" or "Oct 16" (local time). */
export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (dayKey(d) === dayKey(now)) return "today";
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "yesterday";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Above the writing box: "today 08:12", "yesterday 17:40", "Oct 16". */
export function stampLabel(iso: string, now: Date): string {
  const day = dayLabel(iso, now);
  return day === "today" || day === "yesterday" ? `${day} ${clock(iso)}` : day;
}

/** What the sidebar says an idea's latest action did. */
const LATEST: Record<IdeaAction, string> = {
  todo: "in To-do suggestions",
  chat: "chatted",
  session: "session started",
};

/** The sidebar row's mono line: when, and the latest action ("today · in To-do suggestions"). */
export function metaLine(idea: DeskIdea, now: Date): string {
  const last = idea.history.at(-1);
  return [dayLabel(idea.createdAt, now), last ? LATEST[last.kind] : ""].filter(Boolean).join(" · ");
}

const DONE: Record<IdeaAction, string> = {
  todo: "Suggested in To-do",
  chat: "Opened in Chat",
  session: "Session started",
};

export interface HistoryPart {
  text: string;
  link?: string;
  title?: string;
}

/** One line under the buttons: "Suggested in To-do 08:14 · Opened in Chat 08:20 · Session started Oct 16". */
export function historyParts(history: IdeaHistoryEntry[], now: Date): HistoryPart[] {
  return history.map((h) => {
    const day = dayLabel(h.at, now);
    const when = day === "today" ? clock(h.at) : day;
    return {
      text: `${DONE[h.kind]} ${when}`.trim(),
      ...(h.link ? { link: h.link } : {}),
      ...(h.label ? { title: h.label } : {}),
    };
  });
}

export interface IdeaRow {
  idea: DeskIdea;
  title: string;
  meta: string;
}

export interface IdeaGroup {
  /** The project's slug, or "" for Unsorted. */
  slug: string;
  name: string;
  rows: IdeaRow[];
}

/** A project's display name (its slug when it isn't in the list any more). */
export function projectName(slug: string | undefined, projects: IdeaProject[]): string {
  if (!slug) return UNSORTED;
  return projects.find((p) => p.slug.toLowerCase() === slug.toLowerCase())?.name ?? slug;
}

/**
 * The sidebar: ideas matching the filter (text or project name), grouped by project in the projects'
 * order (unknown tags after them), Unsorted last; newest first within a group; empty groups left out.
 */
export function groupIdeas(
  ideas: DeskIdea[],
  projects: IdeaProject[],
  filter: string,
  now: Date,
): IdeaGroup[] {
  const q = filter.trim().toLowerCase();
  const shown = ideas.filter(
    (i) =>
      !q || i.text.toLowerCase().includes(q) || projectName(i.project, projects).toLowerCase().includes(q),
  );
  const order = projects.map((p) => p.slug.toLowerCase());
  const groups = new Map<string, IdeaGroup>();
  for (const idea of [...shown].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const known = idea.project
      ? projects.find((p) => p.slug.toLowerCase() === idea.project!.toLowerCase())
      : undefined;
    const slug = known?.slug ?? idea.project ?? "";
    let g = groups.get(slug.toLowerCase());
    if (!g) groups.set(slug.toLowerCase(), (g = { slug, name: projectName(slug, projects), rows: [] }));
    g.rows.push({ idea, title: ideaTitle(idea.text) || "Untitled idea", meta: metaLine(idea, now) });
  }
  const rank = (g: IdeaGroup) => {
    if (!g.slug) return Number.MAX_SAFE_INTEGER;
    const i = order.indexOf(g.slug.toLowerCase());
    return i === -1 ? order.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ── The "Then" pop-ups ──
// One open at a time. Hover, focus or a click opens one; it stays open while the pointer is over its
// button or itself. Once its context has text it is pinned: open until sent or a click elsewhere, and
// while it's pinned hovering the other buttons opens nothing (clicking one switches). A click elsewhere
// keeps the text as a draft (the amber dot); ✕ discards it; Esc closes.

export interface PopupState {
  hover: IdeaAction | null;
  pinned: IdeaAction | null;
  drafts: Partial<Record<IdeaAction, string>>;
}

export const CLOSED: PopupState = { hover: null, pinned: null, drafts: {} };

const has = (s: PopupState, id: IdeaAction) => Boolean(s.drafts[id]?.trim());

export const popup = {
  isOpen: (s: PopupState, id: IdeaAction) =>
    s.pinned === id || (s.hover === id && (!s.pinned || s.pinned === id)),
  hasDraft: has,
  isPinned: (s: PopupState, id: IdeaAction) => s.pinned === id,
  /** The pointer (or focus) arrives: opens it unless another holds a draft. */
  enter: (s: PopupState, id: IdeaAction): PopupState =>
    !s.pinned || s.pinned === id ? { ...s, hover: id } : s,
  /** The pointer leaves the button and its pop-up. */
  leave: (s: PopupState, id: IdeaAction): PopupState => (s.hover === id ? { ...s, hover: null } : s),
  /** A click on the button: opens this one (pinned if it has a draft); any other closes, its draft kept. */
  click: (s: PopupState, id: IdeaAction): PopupState => ({ ...s, hover: id, pinned: has(s, id) ? id : null }),
  /** Typing in the context field: text pins it; clearing it unpins. */
  type: (s: PopupState, id: IdeaAction, value: string): PopupState => ({
    drafts: { ...s.drafts, [id]: value },
    pinned: value.trim() ? id : s.pinned === id ? null : s.pinned,
    hover: value.trim() ? s.hover : id,
  }),
  /** Go / Enter went through: closed, its text gone. */
  sent: (s: PopupState, id: IdeaAction): PopupState => ({
    hover: null,
    pinned: null,
    drafts: { ...s.drafts, [id]: "" },
  }),
  /** ✕: the draft is thrown away. */
  discard: (s: PopupState, id: IdeaAction): PopupState => ({
    hover: null,
    pinned: null,
    drafts: { ...s.drafts, [id]: "" },
  }),
  /** Esc, or a click anywhere else: closed, drafts kept. */
  close: (s: PopupState): PopupState => (s.hover || s.pinned ? { ...s, hover: null, pinned: null } : s),
};

/** The pop-up's small print. */
export function popupFoot(hasDraft: boolean): string {
  return hasDraft ? "stays open until sent or you click away · ↵ to go" : "context is optional · ↵ to go";
}

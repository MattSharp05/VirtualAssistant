import { describe, expect, it } from "vitest";
import type { DeskIdea, IdeaProject } from "@jarvis/shared";
import {
  CLOSED,
  dayLabel,
  groupIdeas,
  historyParts,
  ideaTitle,
  metaLine,
  popup,
  popupFoot,
  stampLabel,
  type PopupState,
} from "./model";

const NOW = new Date(2026, 9, 20, 9, 30);
const at = (day: number, h = 8, m = 0) => new Date(2026, 9, 20 + day, h, m).toISOString();
const idea = (
  id: string,
  text: string,
  project: string | undefined,
  created: string,
  extra: Partial<DeskIdea> = {},
): DeskIdea => ({
  id,
  text,
  ...(project ? { project } : {}),
  createdAt: created,
  updatedAt: created,
  history: [],
  ...extra,
});
const projects: IdeaProject[] = [
  { slug: "jarvis", name: "JARVIS Desk" },
  { slug: "trip", name: "Trip planner" },
  { slug: "mk", name: "mk" },
];

describe("ideas: labels", () => {
  it("titles are the first non-empty line", () => {
    expect(ideaTitle("\n  Voice notes straight into Ideas.\n\nMore")).toBe(
      "Voice notes straight into Ideas.",
    );
    expect(ideaTitle("  ")).toBe("");
  });

  it("days read today, yesterday, then the date; the stamp adds the time for the first two", () => {
    expect(dayLabel(at(0, 8, 12), NOW)).toBe("today");
    expect(dayLabel(at(-1, 17, 40), NOW)).toBe("yesterday");
    expect(dayLabel(at(-4), NOW)).toBe("Oct 16");
    expect(stampLabel(at(0, 8, 12), NOW)).toBe("today 08:12");
    expect(stampLabel(at(-1, 17, 40), NOW)).toBe("yesterday 17:40");
    expect(stampLabel(at(-4), NOW)).toBe("Oct 16");
  });

  it("the meta line names the latest action; the history line lists them all", () => {
    const i = idea("a", "x", "jarvis", at(0, 8, 12), {
      history: [
        { kind: "todo", at: at(0, 8, 14) },
        { kind: "session", at: at(-1, 10, 0), link: "https://claude.ai/code/session_01", label: "j7" },
        { kind: "chat", at: at(0, 8, 20) },
      ],
    });
    expect(metaLine(i, NOW)).toBe("today · chatted");
    expect(metaLine(idea("b", "x", undefined, at(-6)), NOW)).toBe("Oct 14");
    expect(historyParts(i.history, NOW)).toEqual([
      { text: "Suggested in To-do 08:14" },
      { text: "Session started yesterday", link: "https://claude.ai/code/session_01", title: "j7" },
      { text: "Opened in Chat 08:20" },
    ]);
  });
});

describe("ideas: sidebar groups", () => {
  const ideas = [
    idea("old", "Orb shows a ring per running builder", "jarvis", at(-1)),
    idea("new", "Voice notes straight into Ideas", "jarvis", at(0)),
    idea("slack", "Read-later queue from Slack saves", undefined, at(-8)),
    idea("drift", "Drift boost A/B on staging first", "mk", at(-6)),
    idea("flights", "Auto-hold flights when Sam confirms", "trip", at(-5)),
    idea("other", "Something for a gone project", "gone", at(-2)),
  ];

  it("groups by project in the projects' order, unknown tags next, Unsorted last; newest first", () => {
    const groups = groupIdeas(ideas, projects, "", NOW);
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.idea.id)])).toEqual([
      ["JARVIS Desk", ["new", "old"]],
      ["Trip planner", ["flights"]],
      ["mk", ["drift"]],
      ["gone", ["other"]],
      ["Unsorted", ["slack"]],
    ]);
    expect(groups[0].rows[0]).toMatchObject({ title: "Voice notes straight into Ideas", meta: "today" });
  });

  it("filters by text or project name, case-insensitively, and drops empty groups", () => {
    expect(groupIdeas(ideas, projects, "SLACK", NOW).map((g) => g.name)).toEqual(["Unsorted"]);
    expect(groupIdeas(ideas, projects, "trip", NOW).flatMap((g) => g.rows.map((r) => r.idea.id))).toEqual([
      "flights",
    ]);
    expect(groupIdeas(ideas, projects, "nothing like it", NOW)).toEqual([]);
  });
});

describe("ideas: the Then pop-ups", () => {
  const open = (s: PopupState) => (["todo", "chat", "session"] as const).filter((id) => popup.isOpen(s, id));

  it("hover opens one at a time and leaving closes it", () => {
    let s = popup.enter(CLOSED, "todo");
    expect(open(s)).toEqual(["todo"]);
    s = popup.enter(popup.leave(s, "todo"), "chat");
    expect(open(s)).toEqual(["chat"]);
    expect(open(popup.leave(s, "chat"))).toEqual([]);
    // Leaving a button that isn't the hovered one changes nothing.
    expect(popup.leave(s, "todo")).toBe(s);
  });

  it("typed context pins it: it stays open after the pointer leaves and blocks hovering the others", () => {
    let s = popup.type(popup.enter(CLOSED, "chat"), "chat", "Is the wake word enough?");
    expect(popup.isPinned(s, "chat")).toBe(true);
    s = popup.leave(s, "chat");
    expect(open(s)).toEqual(["chat"]);
    s = popup.enter(s, "todo");
    expect(open(s)).toEqual(["chat"]);
    // Clearing the text unpins it (but it stays open under the pointer).
    s = popup.type(s, "chat", "  ");
    expect(popup.isPinned(s, "chat")).toBe(false);
    expect(open(s)).toEqual(["chat"]);
  });

  it("a click elsewhere keeps the draft (amber dot); clicking its button reopens it pinned; ✕ discards", () => {
    let s = popup.type(popup.enter(CLOSED, "session"), "session", "spike it");
    s = popup.close(s);
    expect(open(s)).toEqual([]);
    expect(popup.hasDraft(s, "session")).toBe(true);
    s = popup.click(s, "session");
    expect(open(s)).toEqual(["session"]);
    expect(popup.isPinned(s, "session")).toBe(true);
    s = popup.discard(s, "session");
    expect(open(s)).toEqual([]);
    expect(popup.hasDraft(s, "session")).toBe(false);
  });

  it("clicking another button switches to it, keeping the first one's draft", () => {
    let s = popup.type(popup.enter(CLOSED, "chat"), "chat", "draft");
    s = popup.click(s, "todo");
    expect(open(s)).toEqual(["todo"]);
    expect(popup.hasDraft(s, "chat")).toBe(true);
    expect(popup.isPinned(s, "todo")).toBe(false);
  });

  it("sending clears the text and closes; Esc closes and keeps it", () => {
    let s = popup.type(popup.enter(CLOSED, "todo"), "todo", "Friday");
    expect(popup.close(s)).toMatchObject({ hover: null, pinned: null, drafts: { todo: "Friday" } });
    s = popup.sent(s, "todo");
    expect(open(s)).toEqual([]);
    expect(popup.hasDraft(s, "todo")).toBe(false);
    expect(popup.close(CLOSED)).toBe(CLOSED);
  });

  it("the small print says whether it stays open", () => {
    expect(popupFoot(false)).toBe("context is optional · ↵ to go");
    expect(popupFoot(true)).toBe("stays open until sent or you click away · ↵ to go");
  });
});

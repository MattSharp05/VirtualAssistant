import { describe, expect, it } from "vitest";
import type { TaskHistoryEntry, TaskItem } from "@jarvis/shared";
import {
  ACTIONS,
  CLOSED,
  dueLabel,
  groupByProject,
  hasDate,
  hasQa,
  historyParts,
  isOverdue,
  popup,
  popupFoot,
  suggestions,
  summary,
  tabTasks,
} from "./model";

const task = (id: string, extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  name: id,
  status: "Open",
  source: "You",
  createdAt: "2026-10-10T08:00:00Z",
  ...extra,
});

const TODAY = "2026-10-14";
const all = [
  task("late", { due: "2026-10-12", project: "Trip" }),
  task("now", { due: "2026-10-14T16:30:00", project: "Personal", priority: "P1" }),
  task("later", { due: "2026-10-20", project: "Trip" }),
  task("someday"),
  task("finished", { status: "Done", createdAt: "2026-10-13T08:00:00Z" }),
  task("older", { status: "Done" }),
  task("idea", { status: "Suggested", why: "because" }),
  task("gone", { status: "Dismissed" }),
];
const ids = (ts: TaskItem[]) => ts.map((t) => t.id);

describe("to-do tabs", () => {
  it("puts open tasks due today or earlier in Today, the rest in Upcoming (like the server)", () => {
    expect(ids(tabTasks(all, "today", TODAY))).toEqual(["late", "now"]);
    expect(ids(tabTasks(all, "upcoming", TODAY))).toEqual(["later", "someday"]);
  });

  it("groups open tasks by project, no project last", () => {
    const groups = groupByProject(tabTasks(all, "project", TODAY));
    expect(groups.map((g) => [g.project, ids(g.tasks)])).toEqual([
      ["Personal", ["now"]],
      ["Trip", ["late", "later"]],
      ["No project", ["someday"]],
    ]);
  });

  it("lists done tasks newest first and suggestions apart", () => {
    expect(ids(tabTasks(all, "done", TODAY))).toEqual(["finished", "older"]);
    expect(ids(suggestions(all))).toEqual(["idea"]);
  });

  it("marks overdue open tasks and sums them up", () => {
    expect(isOverdue(all[0]!, TODAY)).toBe(true);
    expect(isOverdue(all[1]!, TODAY)).toBe(false);
    expect(summary(all, TODAY)).toBe("4 open · 1 overdue");
    expect(summary([task("x")], TODAY)).toBe("1 open");
  });
});

describe("dueLabel", () => {
  it("reads like the mockup: today, tomorrow, a weekday this week, else a date", () => {
    expect(dueLabel("2026-10-14", TODAY)).toBe("today");
    expect(dueLabel("2026-10-14T16:30:00", TODAY)).toBe("today 16:30");
    expect(dueLabel("2026-10-15", TODAY)).toBe("tomorrow");
    expect(dueLabel("2026-10-13", TODAY)).toBe("yesterday");
    expect(dueLabel("2026-10-16", TODAY)).toBe("Fri");
    expect(dueLabel("2026-10-21", TODAY)).toBe("Oct 21");
    expect(dueLabel("2026-10-01", TODAY)).toBe("Oct 1");
    expect(dueLabel("2026-11-02", "2026-10-31")).toBe("Mon");
  });
});

describe("hasDate", () => {
  it.each([
    "call Sam tomorrow",
    "renew passport on Friday",
    "QA batch by fri",
    "dentist next week",
    "pay rent Oct 31",
    "pay rent 31st of October",
    "book flights 2026-11-02",
    "call mum 10/16",
    "standup at 9am",
    "stretch at 15:00",
    "check the oven in 20 minutes",
    "remind me to water the plants",
    "finish the deck EOD",
  ])("“%s” goes to JARVIS", (text) => expect(hasDate(text)).toBe(true));

  it.each([
    "Buy milk",
    "Read the Trip PRD",
    "Sunscreen for the trip",
    "Reply to Alex about the new logo",
    "Ask if we may march on",
    "Fix 3 failing tests",
  ])("“%s” is added directly", (text) => expect(hasDate(text)).toBe(false));
});

describe("hasQa (JD-83)", () => {
  it("is true only for a Notion QA to-do that links to its ticket", () => {
    expect(hasQa(task("qa", { source: "Notion QA", sourceLink: "https://www.notion.so/t1" }))).toBe(true);
    expect(hasQa(task("no-link", { source: "Notion QA" }))).toBe(false);
    expect(hasQa(task("other", { source: "Slack", sourceLink: "https://slack.com/x" }))).toBe(false);
  });
});

describe("the row action pop-ups (JD-83, same state machine as Ideas)", () => {
  it("has Chat and Session, not todo (the item already is one)", () => {
    expect(ACTIONS.map((a) => a.id)).toEqual(["chat", "session"]);
  });

  it("opens on hover unless another holds a draft; clicking opens unpinned, typing pins, clearing unpins", () => {
    let s = popup.enter(CLOSED, "chat");
    expect(popup.isOpen(s, "chat")).toBe(true);
    s = popup.leave(s, "chat");
    expect(popup.isOpen(s, "chat")).toBe(false);

    s = popup.type(CLOSED, "chat", "context");
    expect(popup.isPinned(s, "chat")).toBe(true);
    expect(popup.hasDraft(s, "chat")).toBe(true);
    expect(popup.enter(s, "session")).toEqual(s); // pinned elsewhere: hovering another opens nothing

    s = popup.click(s, "session");
    expect(popup.isOpen(s, "session")).toBe(true);
    expect(popup.isPinned(s, "session")).toBe(false);
    expect(popup.isPinned(s, "chat")).toBe(false); // switched away; chat's draft is kept, just unpinned
    expect(popup.hasDraft(s, "chat")).toBe(true);

    s = popup.type(s, "session", "spike it");
    expect(popup.isPinned(s, "session")).toBe(true);
    s = popup.type(s, "session", "");
    expect(popup.isPinned(s, "session")).toBe(false);

    s = popup.sent(s, "session");
    expect(popup.isOpen(s, "session")).toBe(false);
    expect(s.drafts.session).toBe("");
  });

  it("popupFoot reads differently once a draft exists", () => {
    expect(popupFoot(false)).toMatch(/optional/);
    expect(popupFoot(true)).toMatch(/stays open/);
  });
});

describe("historyParts (JD-83)", () => {
  it("one line per action, today's shows a time, older shows the day; chat has no link, session does", () => {
    const now = new Date("2026-10-21T09:30:00");
    const history: TaskHistoryEntry[] = [
      { kind: "chat", at: "2026-10-21T08:14:00" },
      { kind: "session", at: "2026-10-16T12:00:00", link: "https://claude.ai/code/session_01X", label: "j7" },
    ];
    expect(historyParts(history, now)).toEqual([
      { text: "Opened in Chat 08:14" },
      { text: "Session started Oct 16", link: "https://claude.ai/code/session_01X", title: "j7" },
    ]);
    expect(historyParts(undefined, now)).toEqual([]);
  });
});

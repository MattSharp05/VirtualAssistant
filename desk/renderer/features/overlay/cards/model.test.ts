import { describe, expect, it } from "vitest";
import type { DeskEvent, ScreenCard } from "@jarvis/shared";
import {
  cardsReducer,
  countdown,
  dndOn,
  initialCards,
  noticeActions,
  popOutWindow,
  visibleCards,
  type CardsState,
} from "./model";

const screen = (id: string, kind: ScreenCard["kind"] = "text"): DeskEvent => ({
  type: "card.show",
  card: { id, createdAt: "", title: id, body: "", kind },
});
const notice = (title: string): DeskEvent => ({ type: "notice", at: "", level: "alert", title });

function play(events: DeskEvent[], dnd = false, state: CardsState = initialCards, now = 0): CardsState {
  return events.reduce((s, event) => cardsReducer(s, { type: "event", event, dnd, now }), state);
}

const keys = (s: CardsState) => s.cards.map((c) => c.key);

describe("cards beside the orb", () => {
  it("stacks newest on top, shows at most 3, and the next one moves up when one is dismissed", () => {
    const s = play([screen("a"), screen("b"), screen("c"), screen("d")]);
    expect(visibleCards(s).shown.map((c) => c.key)).toEqual(["card-d", "card-c", "card-b"]);
    expect(visibleCards(s).more).toBe(1);
    const after = cardsReducer(s, { type: "dismiss", key: "card-c" });
    expect(visibleCards(after).shown.map((c) => c.key)).toEqual(["card-d", "card-b", "card-a"]);
    expect(keys(play([{ type: "card.dismiss", id: "d" }], false, after))).toEqual(["card-b", "card-a"]);
  });

  it("shows the same card again on top instead of twice", () => {
    expect(keys(play([screen("a"), screen("b"), screen("a")]))).toEqual(["card-a", "card-b"]);
  });

  it("holds notices back during Do Not Disturb, but not cards he asked for; release shows them", () => {
    const s = play([notice("one"), screen("asked"), notice("two")], true);
    expect(keys(s)).toEqual(["card-asked"]);
    expect(s.queued.map((c) => c.type === "notice" && c.title)).toEqual(["one", "two"]);
    const out = cardsReducer(s, { type: "release" });
    expect(out.queued).toEqual([]);
    expect(out.cards.map((c) => (c.type === "notice" ? c.title : c.key))).toEqual([
      "two",
      "one",
      "card-asked",
    ]);
  });

  it("counts a timer down, then marks it done on top and drops the scheduler's duplicate notice", () => {
    let s = play([
      { type: "timer.started", id: "t", endsAt: "2026-01-01T00:04:12Z", label: "Tea" },
      screen("x"),
    ]);
    s = play([{ type: "timer.done", id: "t", label: "Tea" }], false, s, 1000);
    expect(s.cards[0]).toMatchObject({ type: "timer", id: "t", done: true, endsAt: "2026-01-01T00:04:12Z" });
    expect(s.cards).toHaveLength(2);
    expect(play([notice("⏰ Timer done: Tea")], false, s, 3000).cards).toHaveLength(2);
    expect(play([notice("⏰ Timer done: Tea")], false, s, 9000).cards).toHaveLength(3);
  });

  it("an id'd notice replaces its earlier card, and card.dismiss takes it away (JD-60)", () => {
    const q = (title: string): DeskEvent => ({ type: "notice", id: "task-q", at: "", level: "warn", title });
    const s = play([q("OK to book?"), notice("other"), q("OK to pay?")]);
    expect(s.cards.map((c) => (c.type === "notice" ? c.title : ""))).toEqual(["OK to pay?", "other"]);
    expect(keys(s)[0]).toBe("notice-task-q");
    expect(keys(play([{ type: "card.dismiss", id: "task-q" }], false, s))).toEqual(["notice-2"]);
  });

  it("skips a card or notice missing what it needs instead of throwing while React renders (JD-63)", () => {
    const bad = [
      { type: "card.show" },
      { type: "card.show", card: { id: "x" } },
      { type: "notice", at: "", level: "info" },
      { type: "timer.started", id: "t" },
      { type: "timer.done" },
      { type: "card.dismiss" },
    ] as unknown as DeskEvent[];
    expect(() => play(bad)).not.toThrow();
    expect(play(bad)).toBe(initialCards);
    // A card without a body or rows still shows.
    const bare = { type: "card.show", card: { id: "b", title: "Bare" } } as unknown as DeskEvent;
    expect(keys(play([bare]))).toEqual(["card-b"]);
  });

  it("ignores events that aren't cards", () => {
    const s = play([{ type: "tasks.changed" }]);
    expect(s).toBe(initialCards);
  });
});

describe("card helpers", () => {
  it("pops agenda out to Today and session to Sessions; other kinds have no window", () => {
    const c = (kind: ScreenCard["kind"]) => ({ id: "", createdAt: "", title: "", body: "", kind });
    expect(popOutWindow(c("agenda"))).toBe("today");
    expect(popOutWindow(c("session"))).toBe("sessions");
    expect(popOutWindow(c("list"))).toBeUndefined();
    expect(popOutWindow(c("text"))).toBeUndefined();
    // A browser task's results pop out into the Browser window's results panel (JD-66).
    expect(popOutWindow({ ...c("list"), id: "browser-task-t1" })).toBe("browser");
    expect(popOutWindow({ ...c("text"), id: "browser-task-t1" })).toBeUndefined();
  });

  it("gives notices their own actions, Open for a bare link, and a Later when there's something to do", () => {
    expect(noticeActions(undefined, undefined)).toEqual([]);
    expect(noticeActions(undefined, "https://x")).toEqual([
      { label: "Open", url: "https://x" },
      { label: "Later" },
    ]);
    const own = [{ label: "Open session", window: "sessions" }, { label: "Later" }];
    expect(noticeActions(own, "https://x")).toEqual(own);
    // Buttons that call the Desk API (a browser task's Approve / Stop) need no Later.
    const ask = [
      { label: "Approve", request: { path: "/browser/tasks/t/answer" } },
      { label: "Change", window: "browser" },
    ];
    expect(noticeActions(ask, undefined)).toEqual(ask);
  });

  it("reads Do Not Disturb from a boolean or { on, until }", () => {
    expect(dndOn(true)).toBe(true);
    expect(dndOn({ on: false })).toBe(false);
    expect(dndOn({ on: true })).toBe(true);
    expect(dndOn({ on: true, until: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(
      false,
    );
    expect(dndOn(undefined)).toBeUndefined();
    expect(dndOn("yes")).toBeUndefined();
  });

  it("formats the countdown", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(countdown("2026-01-01T00:04:12Z", now)).toBe("4:12");
    expect(countdown("2026-01-01T01:02:03Z", now)).toBe("1:02:03");
    expect(countdown("2025-12-31T23:59:00Z", now)).toBe("0:00");
  });
});

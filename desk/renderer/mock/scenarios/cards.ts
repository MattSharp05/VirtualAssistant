// Cards beside the orb (JD-27, mockups 1–2) for the preview, e2e and snapshots: open them with
// ?window=overlay. Timer ends are relative to page load (e2e pins the clock).
import type { DeskEvent, ScreenCard } from "@jarvis/shared";
import type { Scenario, TimedEvent } from "../types";

const loaded = Date.now();
const at = "2026-10-14T09:12:00Z";

const card = (c: Omit<ScreenCard, "createdAt">): DeskEvent => ({
  type: "card.show",
  card: { ...c, createdAt: at },
});

const agenda = card({
  id: "today-agenda",
  title: "Today",
  kind: "agenda",
  body: "Also: 2 emails worth reading, 1 Slack mention, and **mk is waiting on a decision**.",
  items: [
    { label: "Stand-up", detail: "10:00" },
    { label: "Lunch with Sam", detail: "12:30" },
    { label: "Trip planning call", detail: "16:00" },
  ],
});

const mkBlocked: DeskEvent = {
  type: "notice",
  at,
  level: "alert",
  title: "⛔ mk is blocked",
  body: "Needs a decision: keep drift boost or cut it for v1?",
  link: "https://claude.ai/code/session_01MK",
  actions: [{ label: "Open session", window: "sessions", params: { id: "mk" } }, { label: "Later" }],
};

const tea: DeskEvent = {
  type: "timer.started",
  id: "tea",
  endsAt: new Date(loaded + 4 * 60_000 + 12_000).toISOString(),
  label: "Tea",
};

const mood = (dnd: boolean) => ({ "/mood": { mood: "green", reason: "all fine", dnd: { on: dnd } } });

const one = (name: string, description: string, events: TimedEvent[], dnd = false): Scenario => ({
  name,
  description,
  data: mood(dnd),
  events,
});

const words = (messageId: string, text: string): TimedEvent[] =>
  text.split(/(?<= )/).map((w) => ({ after: 30, event: { type: "brain.delta", messageId, text: w } }));

const spoken =
  "Three things today. Your stand-up at 10, lunch with Sam at 12:30, and the trip planning call at 4. Also, mk needs a decision from you.";

const scenarios: Scenario[] = [
  one("cards", "Beside the orb: the Today agenda card, mk's blocked alert and a tea timer counting down.", [
    { after: 200, event: agenda },
    { after: 150, event: mkBlocked },
    { after: 150, event: tea },
  ]),
  one(
    "cards-dnd",
    "Do Not Disturb is on: the card Matthew asked for shows, two notices wait as a badge on the orb.",
    [
      {
        after: 200,
        event: card({
          id: "flights",
          title: "Flights to Lisbon",
          kind: "list",
          body: "Cheapest is **TAP**, direct.",
          items: [
            { label: "TAP 1351 · direct", detail: "£142" },
            { label: "easyJet 8123 · direct", detail: "£168" },
          ],
        }),
      },
      { after: 150, event: mkBlocked },
      {
        after: 150,
        event: {
          type: "notice",
          at,
          level: "info",
          title: "✅ trip finished",
          body: "6 tickets ready for QA",
        },
      },
    ],
    true,
  ),
  one(
    "cards-voice",
    "A voice reply (mockup 1): “You said”, the agenda card, and the spoken words as a caption.",
    [
      { after: 100, event: { type: "voice.transcript", text: "Jarvis, what's on", final: false } },
      { after: 200, event: { type: "voice.transcript", text: "Jarvis, what's on today?", final: true } },
      {
        after: 200,
        event: {
          type: "brain.start",
          messageId: "v1",
          channel: "desk-voice",
          text: "Jarvis, what's on today?",
        },
      },
      { after: 0, event: { type: "orb.state", state: "thinking" } },
      { after: 300, event: agenda },
      { after: 0, event: { type: "orb.state", state: "speaking", amplitude: 0.7 } },
      ...words("v1", spoken),
    ],
  ),
  one(
    "cards-shown",
    "Cards JARVIS put up: a text card with markdown and a link, a list and a session card.",
    [
      {
        after: 200,
        event: card({
          id: "mk-session",
          title: "mk",
          kind: "session",
          body: "",
          items: [
            { label: "MK-81 drift boost", detail: "blocked" },
            { label: "MK-79 lap timer", detail: "merged" },
            { label: "MK-80 ghost replay", detail: "in review" },
          ],
        }),
      },
      {
        after: 150,
        event: card({
          id: "groceries",
          title: "Groceries",
          kind: "list",
          body: "",
          items: [
            { label: "Oat milk" },
            { label: "Coffee beans", detail: "Square Mile" },
            { label: "Lemons" },
          ],
        }),
      },
      {
        after: 150,
        event: card({
          id: "hotel",
          title: "Hotel budget",
          kind: "text",
          body: "Trip asks for a nightly cap.\n\n- Lisbon average: **£135**\n- Your last two trips: *£120* and *£150*\n\nSay a number and I'll pass it on.",
          link: { label: "Open the trip PRD", url: "https://www.notion.so/trip-prd" },
        }),
      },
    ],
  ),
  one("cards-notices", "Notices by level (warn amber, info green) and a timer that just finished.", [
    {
      after: 200,
      event: { type: "notice", at, level: "info", title: "✅ trip finished", body: "6 tickets ready for QA" },
    },
    {
      after: 150,
      event: {
        type: "notice",
        at,
        level: "warn",
        title: "⚠️ shapemint: something failed",
        body: "CI is red on SM-12 (lint).",
        link: "https://claude.ai/code/session_01SM",
      },
    },
    {
      after: 150,
      event: { type: "timer.started", id: "pasta", endsAt: new Date(loaded).toISOString(), label: "Pasta" },
    },
    { after: 100, event: { type: "timer.done", id: "pasta", label: "Pasta" } },
    // The scheduler's own "Timer done" notice is folded into the timer's card.
    { after: 50, event: { type: "notice", at, level: "info", title: "⏰ Timer done: Pasta" } },
  ]),
];

export default scenarios;

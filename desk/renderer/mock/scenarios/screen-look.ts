// Screen awareness and clipboard help (JD-44) beside the orb, for the preview, e2e and snapshots: open
// them with ?window=overlay. The cards are the ones main shows each time it looks (main/rpcHandlers/
// screen.ts and clipboard.ts); in the app they leave after 6 s, here they stay for the snapshot.
import type { DeskEvent, ScreenCard } from "@jarvis/shared";
import type { Scenario, TimedEvent } from "../types";

const at = "2026-10-15T09:12:00Z";
const mood = { "/mood": { mood: "green", reason: "all fine", dnd: { on: false } } };

const card = (c: Omit<ScreenCard, "createdAt" | "kind">): DeskEvent => ({
  type: "card.show",
  card: { ...c, kind: "text", createdAt: at },
});

const asked = (messageId: string, text: string): TimedEvent[] => [
  { after: 100, event: { type: "voice.transcript", text, final: true } },
  { after: 100, event: { type: "brain.start", messageId, channel: "desk-voice", text } },
  { after: 0, event: { type: "orb.state", state: "thinking" } },
];

const spoken = (messageId: string, text: string): TimedEvent[] => [
  { after: 0, event: { type: "orb.state", state: "speaking", amplitude: 0.6 } },
  ...text
    .split(/(?<= )/)
    .map((w) => ({ after: 30, event: { type: "brain.delta" as const, messageId, text: w } })),
];

const scenarios: Scenario[] = [
  {
    name: "screen-look",
    description:
      "“Jarvis, what am I looking at?”: the brief “📸 Looked at your screen” card and the spoken answer.",
    data: mood,
    events: [
      ...asked("s1", "Jarvis, what am I looking at?"),
      {
        after: 400,
        event: card({
          id: "screen-look",
          title: "📸 Looked at your screen",
          body: "One screenshot of this display, because you asked.",
        }),
      },
      ...spoken(
        "s1",
        "That's the Lisbon trip PRD in Notion, open at the budget section. The nightly hotel cap is still blank.",
      ),
    ],
  },
  {
    name: "clipboard-read",
    description: "“Jarvis, tidy up what's on my clipboard”: the “📋 Read your clipboard” card.",
    data: mood,
    events: [
      ...asked("c1", "Jarvis, tidy up what's on my clipboard."),
      {
        after: 300,
        event: card({
          id: "clipboard-read",
          title: "📋 Read your clipboard",
          body: "The text you copied, because you asked.",
        }),
      },
      ...spoken("c1", "Here's a tidier version. I've put it in the chat so you can copy it."),
    ],
  },
];

export default scenarios;

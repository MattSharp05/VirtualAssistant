// Push-to-talk (JD-31) as the overlay shows it, for the preview, e2e and snapshots (?window=overlay):
// the events main publishes when right ⌥ is double-tapped. The cards come from main's own builders,
// so the preview shows the real wording.
import type { DeskEvent, OrbState } from "@jarvis/shared";
import { permissionCard } from "../../../main/permissions";
import { missedCard, pttHint } from "../../../main/voice/cards";
import type { Scenario, TimedEvent } from "../types";

const at = new Date("2026-10-15T09:00:00Z");
const hint = pttHint("RightAlt-double");

const orb = (state: OrbState, amplitude?: number): TimedEvent => ({
  after: 0,
  event: { type: "orb.state", state, ...(amplitude === undefined ? {} : { amplitude }) },
});

/** The mic level while Matthew talks (~20 a second from the endpointer), then a quiet tail. */
const talking = (count: number): TimedEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    ...orb(
      "listening",
      i < count - 4 ? Math.round((0.3 + 0.6 * Math.abs(Math.sin(i * 0.7))) * 100) / 100 : 0.05,
    ),
    after: 50,
  }));

const asked = "What's on today?";
const reply = "Three things: stand-up at 10, lunch with Sam at 12:30 and the trip planning call at 4.";
const words = (messageId: string): TimedEvent[] =>
  reply.split(/(?<= )/).map((text) => ({ after: 30, event: { type: "brain.delta", messageId, text } }));

const one = (name: string, description: string, events: TimedEvent[]): Scenario => ({
  name,
  description,
  data: { "/mood": { mood: "green", reason: "all fine", dnd: { on: false } } },
  events,
});

const done: DeskEvent = {
  type: "brain.done",
  messageId: "ptt1",
  text: reply,
  metrics: {
    ms: 2400,
    model: "sonnet",
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 1,
  },
};

const scenarios: Scenario[] = [
  one("ptt-listening", "Right ⌥ double-tapped: the orb listens (blue) and follows the mic level.", [
    { ...orb("listening", 0), after: 100 },
    ...talking(24),
    { ...orb("listening", 0.6), after: 50 },
  ]),
  one(
    "ptt-asked",
    "Push-to-talk end to end: listening, thinking, “You said”, JARVIS's reply as a caption, then idle.",
    [
      { ...orb("listening", 0), after: 100 },
      ...talking(20),
      { ...orb("thinking"), after: 50 },
      { after: 300, event: { type: "voice.transcript", text: asked, final: true } },
      { after: 200, event: { type: "brain.start", messageId: "ptt1", channel: "desk-voice", text: asked } },
      orb("thinking"),
      ...words("ptt1"),
      { after: 50, event: done },
      orb("idle"),
    ],
  ),
  one("ptt-missed", "Push-to-talk heard nothing: the orb rests and a “Didn't catch that” card shows.", [
    { ...orb("listening", 0), after: 100 },
    ...talking(6).map((e) => ({
      ...e,
      event: { type: "orb.state", state: "listening", amplitude: 0.04 } as DeskEvent,
    })),
    { ...orb("idle"), after: 50 },
    {
      after: 0,
      event: { type: "card.show", card: missedCard({ text: "", ms: 0, reason: "no-speech" }, hint, at) },
    },
  ]),
  one(
    "ptt-permission",
    "First run: macOS hasn't allowed the hotkey yet; a card gives the Input Monitoring steps and Open Settings.",
    [{ after: 200, event: { type: "card.show", card: permissionCard("input-monitoring", hint, at) } }],
  ),
];

export default scenarios;

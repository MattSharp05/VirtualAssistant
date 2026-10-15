// The ambient face (JD-25, mockup 9): the demo day at 09:00, the same day with JARVIS talking, and a
// quiet day with nothing on and the plan usage unavailable.
import type { DeskEvent, Digest, MoodResponse, OrbState } from "@jarvis/shared";
import { usage } from "../data/ambient";
import { sessions } from "../data/sessions";
import { today, todayActions } from "../data/today";
import type { Scenario, TimedEvent } from "../types";

const NINE_AM = "2026-10-14T09:00:00+01:00";
const red: MoodResponse = { mood: "red", reason: "mk is blocked", dnd: { on: false } };

const data = {
  "/today": today,
  "/tasks?view=today": todayActions["/tasks?view=today"],
  "/sessions": sessions,
  "/usage": usage,
  "/mood": red,
};

const state = (s: OrbState, amplitude?: number): DeskEvent => ({
  type: "orb.state",
  state: s,
  ...(amplitude !== undefined ? { amplitude } : {}),
});

/** listening → thinking → speaking → idle, five rounds. */
const talking: TimedEvent[] = Array.from({ length: 5 }, (_, round) => [
  { after: round === 0 ? 500 : 2500, event: state("listening") },
  { after: 2000, event: state("thinking") },
  ...Array.from({ length: 16 }, (_, i) => ({
    after: i === 0 ? 2000 : 120,
    event: state("speaking", Math.round((0.35 + 0.6 * Math.abs(Math.sin(i * 0.9))) * 100) / 100),
  })),
  { after: 120, event: state("idle") },
]).flat();

const quiet: Digest = {
  ...today.digest!,
  events: [],
  inbox: [],
  skippedCount: 0,
  slack: [],
  tasksDue: [],
  sessionsWaiting: [],
};

const scenarios: Scenario[] = [
  {
    name: "ambient",
    description:
      "Ambient face at 09:00: Standup next, 2 to-dos, sessions 2 working / 1 waiting / 1 blocked, plan 42% and 18%.",
    data,
    events: [],
    ui: { now: NINE_AM },
  },
  {
    name: "ambient-speaking",
    description: "Ambient face while JARVIS speaks: the large orb's rings pulse with the voice.",
    data,
    events: [{ after: 100, event: state("speaking", 0.8) }],
    ui: { now: NINE_AM },
  },
  {
    name: "ambient-cycle",
    description: "Ambient face following the orb: listening, thinking, speaking, idle, five times.",
    data,
    events: talking,
    ui: { now: NINE_AM },
  },
  {
    name: "ambient-quiet",
    description: "Ambient face on a quiet day: nothing next, no to-dos or sessions, plan usage unavailable.",
    data: {
      "/today": { running: false, ageSeconds: 300, digest: quiet },
      "/sessions": [],
      "/usage": { available: false, reason: "not signed in to claude.ai", checkedAt: "2026-10-14T08:55:00Z" },
      "/mood": { mood: "green", reason: "all fine", dnd: { on: false } },
    },
    events: [],
    ui: { now: NINE_AM },
  },
];

export default scenarios;

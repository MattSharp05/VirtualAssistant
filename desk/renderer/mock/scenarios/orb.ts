// The orb's states and moods (JD-19) for the preview, e2e and `JARVIS_DESK_SCENARIO=orb-cycle`.
import type { DeskEvent, OrbState } from "@jarvis/shared";
import type { Scenario, TimedEvent } from "../types";

const state = (s: OrbState, amplitude?: number): DeskEvent => ({
  type: "orb.state",
  state: s,
  ...(amplitude !== undefined ? { amplitude } : {}),
});

/** Speech-like amplitude for the speaking scenarios. */
const talking = (from: number, count: number): TimedEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    after: i === 0 ? from : 120,
    event: state("speaking", Math.round((0.35 + 0.6 * Math.abs(Math.sin(i * 0.9))) * 100) / 100),
  }));

const one = (name: string, description: string, events: TimedEvent[]): Scenario => ({
  name,
  description,
  data: { "/mood": { mood: "green" } },
  events,
});

/** listening → thinking → speaking → idle, every 2 s, 10 rounds. */
const cycle: TimedEvent[] = Array.from({ length: 10 }, (_, round) => [
  { after: round === 0 ? 300 : 2000, event: state("listening") },
  { after: 2000, event: state("thinking") },
  ...talking(2000, 16),
  { after: 120, event: state("idle") },
]).flat();

const scenarios: Scenario[] = [
  one("orb-idle", "The orb at rest: a faint dot in the top-right corner.", []),
  one("orb-listening", "JARVIS is listening (blue, pulses moving inward).", [
    { after: 100, event: state("listening") },
  ]),
  one("orb-thinking", "JARVIS is thinking (spinning arc).", [{ after: 100, event: state("thinking") }]),
  one("orb-speaking", "JARVIS is speaking (rings pulse with the voice).", [
    { after: 100, event: state("speaking", 0.8) },
  ]),
  {
    ...one("orb-mood-red", "Idle, but a session is blocked: the dot glows red.", [
      { after: 100, event: { type: "mood.changed", mood: "red", reason: "mk is blocked" } },
    ]),
    data: { "/mood": { mood: "green" } },
  },
  one("orb-cycle", "Loops through listening, thinking, speaking and idle every 2 s.", cycle),
];

export default scenarios;

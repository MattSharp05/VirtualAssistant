// Scenarios drive the mock bridge (web preview, e2e, JARVIS_DESK_SCENARIO): a named, deterministic
// state plus events replayed with timings (docs/TDD.md → Scenario system).
import type { DeskEvent } from "@jarvis/shared";

/** An event replayed `after` ms after the previous one (or after the bridge starts). */
export interface TimedEvent {
  after: number;
  event: DeskEvent;
}

/** Part of a scenario's state; demo-day merges every file in mock/data/. */
export interface ScenarioPart {
  /** Responses for bridge.request(path), keyed by Desk API path, e.g. "/sessions"; a function gets the body. */
  data?: Record<string, unknown>;
  events?: TimedEvent[];
}

export interface Scenario extends Required<ScenarioPart> {
  name: string;
  description: string;
  /** What JARVIS answers in chat (streamed word by word). */
  chatReply?: string;
  /** How the UI starts, for states no event leads to (e.g. the launcher ring already open). */
  ui?: ScenarioUi;
}

export interface ScenarioUi {
  launcherOpen?: boolean;
}

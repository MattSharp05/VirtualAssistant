// Scenarios drive the mock bridge (web preview, e2e, JARVIS_DESK_SCENARIO): a named, deterministic
// state plus events replayed with timings (docs/TDD.md → Scenario system).
import type { ConnectionTest, DeskConnection, DeskEvent, VoiceInfo } from "@jarvis/shared";

/** An event replayed `after` ms after the previous one (or after the bridge starts). */
export interface TimedEvent {
  after: number;
  event: DeskEvent;
}

/**
 * Answers requests static data can't (writes that change state, views computed from it). Returns
 * undefined for paths it doesn't handle; throws to fail the request. `data` is this bridge's own copy
 * of the scenario's data, so a route can keep state in it.
 */
export type MockRoute = (
  path: string,
  body: unknown,
  ctx: { data: Record<string, unknown>; emit(event: DeskEvent): void },
) => unknown;

/** Part of a scenario's state; demo-day merges every file in mock/data/. */
export interface ScenarioPart {
  /** Responses for bridge.request(path), keyed by Desk API path, e.g. "/sessions"; a function gets the body. */
  data?: Record<string, unknown>;
  events?: TimedEvent[];
  /** Tried in order before `data`. */
  routes?: MockRoute[];
}

export interface Scenario extends Required<Omit<ScenarioPart, "routes">> {
  routes?: MockRoute[];
  name: string;
  description: string;
  /** What JARVIS answers in chat (streamed word by word). */
  chatReply?: string;
  /** How the UI starts, for states no event leads to (e.g. the launcher ring already open). */
  ui?: ScenarioUi;
  /** Settings the bridge starts with (a secret's value is true when one is "stored"). */
  settings?: Record<string, unknown>;
  /** How the Mac side answers (Settings window, JD-26); see mock/mac.ts for the defaults. */
  mac?: MockMac;
}

export interface MockMac {
  connection?: DeskConnection;
  /** What Test connection answers once a URL and key are set. */
  test?: ConnectionTest;
  voices?: VoiceInfo[];
  /** What the folder picker returns, in turn (then it's cancelled). */
  folders?: string[];
}

export interface ScenarioUi {
  launcherOpen?: boolean;
  /** The preview's clock (ISO time): windows that show "today" start here instead of the real now. */
  now?: string;
}

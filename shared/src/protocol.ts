// The contract between the JARVIS server and JARVIS Desk (docs/TDD.md → Desk API).
// Both sides import from here; changing it means updating both in the same PR.

/** Bumped whenever the Desk API changes in a way an older Desk can't handle. */
export const PROTOCOL_VERSION = 1;

/** What the orb is doing (mockup 2). */
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type NoticeLevel = "info" | "warn" | "alert";

/**
 * Everything the server pushes to the Desk over the live stream (and publishes on its event bus).
 * Features add their own members here.
 */
export type DeskEvent =
  | { type: "orb.state"; state: OrbState; amplitude?: number }
  | { type: "notice"; at: string; level: NoticeLevel; title: string; body?: string };

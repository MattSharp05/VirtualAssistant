// The contract between the JARVIS server and JARVIS Desk (docs/TDD.md → Desk API).
// Both sides import from here; changing it means updating both in the same PR.

/** Bumped whenever the Desk API changes in a way an older Desk can't handle. */
export const PROTOCOL_VERSION = 3;

/** What the orb is doing (mockup 2). */
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type NoticeLevel = "info" | "warn" | "alert";

/** Where a message to the brain came from. */
export type BrainChannel = "dashboard" | "telegram" | "desk-voice" | "desk-typed";

/** Per-reply measurements for the brain, the same kind sessions report. */
export interface BrainMetrics {
  ms: number;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
  /** What the reply would cost on the API; on the subscription it's a guide to plan usage, not a bill. */
  apiEquivalentUsd?: number;
}

/**
 * Everything the server pushes to the Desk over the live stream (and publishes on its event bus).
 * Features add their own members here.
 */
export type DeskEvent =
  | { type: "orb.state"; state: OrbState; amplitude?: number }
  | { type: "notice"; at: string; level: NoticeLevel; title: string; body?: string }
  // The brain's reply as it's written (JD-6). One messageId per user turn; deltas are chunks to append.
  | { type: "brain.start"; messageId: string; channel: BrainChannel; text: string }
  | { type: "brain.delta"; messageId: string; text: string }
  | { type: "brain.tool"; messageId: string; phase: "call" | "result"; name: string; input?: unknown; summary?: string; isError?: boolean }
  | { type: "brain.done"; messageId: string; text: string; metrics: BrainMetrics }
  | { type: "brain.error"; messageId: string; error: string }
  /** The server asks the Mac for something (a file, the clipboard…); the Desk answers with POST /api/desk/rpc/:id. */
  | { type: "rpc"; id: string; kind: string; payload: unknown };

/** One event on the live stream, numbered so a reconnecting Desk can catch up (Last-Event-ID). */
export interface StreamedEvent {
  id: number;
  event: DeskEvent;
}

// ── Desk API (all under /api/desk; every route except health needs `Authorization: Bearer <device key>`) ──

/** GET /api/desk/health */
export interface HealthResponse {
  ok: true;
  protocol: number;
}

/** GET /api/desk/me */
export interface MeResponse {
  id: string;
  name: string;
}

/** POST /api/desk/rpc/:id */
export type RpcAnswer = { ok: true; result: unknown } | { ok: false; error: string };

/** POST /api/desk/chat: the reply streams over /api/desk/events as brain.* events with this messageId. */
export interface ChatRequest {
  text: string;
  channel: "desk-voice" | "desk-typed";
}
export interface ChatResponse {
  messageId: string;
}

/** A paired Mac, as the dashboard lists it (never includes the key). */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeen?: string;
}

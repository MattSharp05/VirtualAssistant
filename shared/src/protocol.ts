// The contract between the JARVIS server and JARVIS Desk (docs/TDD.md → Desk API).
// Both sides import from here; changing it means updating both in the same PR.

/** Bumped whenever the Desk API changes in a way an older Desk can't handle. */
export const PROTOCOL_VERSION = 3;

/** What the orb is doing (mockup 2). */
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type NoticeLevel = "info" | "warn" | "alert";

/** red: a session is blocked · amber: something waits on Matthew or plan usage is high · green: all fine. */
export type Mood = "green" | "amber" | "red";

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
  | { type: "notice"; at: string; level: NoticeLevel; title: string; body?: string; link?: string }
  /** How things are, for the orb's colour (JD-11). */
  | { type: "mood.changed"; mood: Mood; reason: string }
  // The brain's reply as it's written (JD-6). One messageId per user turn; deltas are chunks to append.
  | { type: "brain.start"; messageId: string; channel: BrainChannel; text: string }
  | { type: "brain.delta"; messageId: string; text: string }
  | { type: "brain.tool"; messageId: string; phase: "call" | "result"; name: string; input?: unknown; summary?: string; isError?: boolean }
  | { type: "brain.done"; messageId: string; text: string; metrics: BrainMetrics }
  | { type: "brain.error"; messageId: string; error: string }
  /** JARVIS Tasks changed (added, completed, edited); windows re-fetch /tasks. */
  | { type: "tasks.changed" }
  /** JARVIS changed Matthew's calendar (JD-14); the Calendar window's "Changed by JARVIS" log. */
  | { type: "calendar.changed"; entry: CalendarChange }
  /** The JARVIS Memory page changed (JARVIS wrote to it, or Matthew edited it in Notion). */
  | { type: "memory.changed" }
  /** A card next to the orb (JD-8, rendered by JD-27). */
  | { type: "card.show"; card: ScreenCard }
  | { type: "card.dismiss"; id: string }
  /** Timers and reminders (JD-10). */
  | { type: "timer.started"; id: string; endsAt: string; label?: string }
  | { type: "timer.done"; id: string; label?: string }
  | { type: "reminder.due"; id: string; text: string; late: boolean }
  /** The server asks the Mac for something (a file, the clipboard…); the Desk answers with POST /api/desk/rpc/:id. */
  | { type: "rpc"; id: string; kind: string; payload: unknown };

/** What JARVIS puts on screen with show_on_screen. Body is short markdown. */
export interface ScreenCard {
  id: string;
  createdAt: string;
  title: string;
  body: string;
  kind: "text" | "list" | "agenda" | "session";
  items?: { label: string; detail?: string }[];
  link?: { label: string; url: string };
}

/** One calendar write JARVIS made, with what the event looked like before (for undo). */
export interface CalendarChange {
  id: string;
  at: string;
  /** create_event, update_event, delete_event or respond_to_event. */
  tool: string;
  input: unknown;
  /** The tool's answer (the event after the change, or a confirmation). */
  result: string;
  /** get_event's answer for the same event earlier in that turn (update/delete). */
  before?: string;
  /** One line for the log, e.g. "update_event: Booking call → 2026-10-17T14:00:00". */
  summary: string;
  undoneAt?: string;
  /** Set on the change that undid another. */
  undoOf?: string;
}

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
  /** Upload ids from POST /api/desk/files. */
  attachments?: string[];
}

/** POST /api/desk/files (multipart, field "file", ≤ 20 MB) */
export interface UploadResponse {
  id: string;
  path: string;
  name: string;
}
export interface ChatResponse {
  messageId: string;
}

// ── JARVIS Tasks (a Notion database Matthew can see and edit; ADR 0006) ──

export type TaskStatus = "Suggested" | "Open" | "Done" | "Dismissed";
export type TaskSource = "You" | "Slack" | "Email" | "Session" | "Notion QA";
export type TaskPriority = "P1" | "P2" | "P3";

export interface TaskItem {
  id: string;
  name: string;
  status: TaskStatus;
  /** YYYY-MM-DD (or an ISO date-time). */
  due?: string;
  project?: string;
  priority?: TaskPriority;
  source: TaskSource;
  sourceLink?: string;
  createdAt: string;
  /** The row in Notion. */
  url?: string;
}

/** GET /api/desk/tasks?view=… */
export type TaskView = "today" | "upcoming" | "project" | "done" | "suggested";
export interface TasksResponse {
  view: TaskView;
  tasks: TaskItem[];
}

/** POST /api/desk/tasks */
export interface NewTask {
  name: string;
  due?: string;
  project?: string;
  priority?: TaskPriority;
}

/** GET /api/desk/mood */
export interface MoodResponse {
  mood: Mood;
  reason: string;
  dnd: DndState;
}

/** POST /api/desk/dnd { on, until? } → DndState. While on, notices aren't sent to Telegram. */
export interface DndState {
  on: boolean;
  until?: string;
}

/** A paired Mac, as the dashboard lists it (never includes the key). */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeen?: string;
}

// ── The Desk bridge (window.desk): the renderer's only door to the rest of the app ──
// In Electron, preload implements it over IPC and main talks to the server; in the web preview
// (and e2e) a mock implements it from a scenario (desk/renderer/mock/). Features extend it.

export interface DeskBridge {
  protocolVersion: number;
  /** Live events from the server's stream. Returns an unsubscribe function. */
  subscribe(fn: (event: DeskEvent) => void): () => void;
  /** A Desk API route under /api/desk, e.g. request("/me"); GET without a body, POST with one. */
  request<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Talk to JARVIS; the reply arrives through subscribe() as brain.* events with this messageId. */
  chat(text: string, channel?: ChatRequest["channel"]): Promise<ChatResponse>;
  /** Opens (or focuses) one of the Desk's windows by feature id. */
  openWindow(id: string): void;
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** The overlay window (JD-19): click-through except where the renderer says it's interactive. */
  overlay?: {
    /** True while the pointer is over the orb (or another interactive region): clicks land on JARVIS. */
    setInteractive(on: boolean): void;
    /** The orb was clicked (the launcher ring arrives in JD-20). */
    orbClicked(): void;
  };
}

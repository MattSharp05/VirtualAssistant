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
export type BrainChannel = "dashboard" | "telegram" | "desk-voice" | "desk-typed" | "worker";

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
  | { type: "notice"; at: string; level: NoticeLevel; title: string; body?: string; link?: string; actions?: NoticeAction[] }
  /** How things are, for the orb's colour (JD-11). */
  | { type: "mood.changed"; mood: Mood; reason: string }
  // The brain's reply as it's written (JD-6). One messageId per user turn; deltas are chunks to append.
  | { type: "brain.start"; messageId: string; channel: BrainChannel; text: string }
  | { type: "brain.delta"; messageId: string; text: string }
  | { type: "brain.tool"; messageId: string; phase: "call" | "result"; name: string; input?: unknown; summary?: string; isError?: boolean }
  | { type: "brain.done"; messageId: string; text: string; metrics: BrainMetrics }
  | { type: "brain.error"; messageId: string; error: string }
  /** What the Mac heard (JD-31's voice loop): partial while listening, final once he stops. The overlay's "You said" bubble (JD-27). */
  | { type: "voice.transcript"; text: string; final: boolean }
  /** JARVIS Tasks changed (added, completed, edited); windows re-fetch /tasks. */
  | { type: "tasks.changed" }
  /** JARVIS changed Matthew's calendar (JD-14); the Calendar window's "Changed by JARVIS" log. */
  | { type: "calendar.changed"; entry: CalendarChange }
  /** A fresh Today digest is ready (JD-17); GET /api/desk/today. */
  | { type: "today.updated"; generatedAt: string }
  /** The morning brief's text (JD-23); its reply also streams as brain.* events with this messageId. */
  | { type: "brief.ready"; messageId: string; text: string; at: string }
  /** The JARVIS Memory page changed (JARVIS wrote to it, or Matthew edited it in Notion). */
  | { type: "memory.changed" }
  /** A card next to the orb (JD-8, rendered by JD-27). */
  | { type: "card.show"; card: ScreenCard }
  | { type: "card.dismiss"; id: string }
  /** Timers and reminders (JD-10). */
  | { type: "timer.started"; id: string; endsAt: string; label?: string }
  | { type: "timer.done"; id: string; label?: string }
  | { type: "reminder.due"; id: string; text: string; late: boolean }
  /** A session reported in or was messaged (JD-32); the Sessions window re-fetches /sessions. */
  | { type: "sessions.changed" }
  /** The server asks the Mac for something (a file, the clipboard…); the Desk answers with POST /api/desk/rpc/:id. */
  | { type: "rpc"; id: string; kind: string; payload: unknown };

/** A button on a notice's card (JD-27): opens a Desk window or a link; neither just dismisses ("Later"). */
export interface NoticeAction {
  label: string;
  /** A Desk window id (openWindow), with its params, e.g. { window: "sessions", params: { id: "mk" } }. */
  window?: string;
  params?: Record<string, string>;
  url?: string;
}

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

// Folder access (JD-41, ADR 0009): `rpc` kinds "fs.list" and "fs.read", answered by the Desk only for
// paths inside Settings → Folders (no hidden files; text/PDF/images up to FS_MAX_FILE_BYTES).

export const FS_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const FS_MAX_LIST_ENTRIES = 200;

/** rpc "fs.list": a folder's files (recursively), or the allowed folders themselves without `folder`. */
export interface FsListRequest {
  folder?: string;
  /** A name pattern with * and ?, case-insensitive, e.g. "*trip*.md". */
  pattern?: string;
}

export interface FsEntry {
  /** Absolute path on the Mac (what fs.read takes). */
  path: string;
  type: "file" | "folder";
  size?: number;
  modified?: string;
}

export interface FsListResult {
  folder?: string;
  entries: FsEntry[];
  /** More than FS_MAX_LIST_ENTRIES matched; narrow it with a pattern or a subfolder. */
  truncated: boolean;
}

/** rpc "fs.read" */
export interface FsReadRequest {
  path: string;
}

export interface FsReadResult {
  name: string;
  size: number;
  /** The file's bytes, base64. */
  data: string;
}

/** The rpc kind that applies a saved window layout on the Mac (JD-37): payload { name }, result LayoutApplied. */
export const LAYOUT_RPC = "layout.apply";
export interface LayoutApplied {
  /** The layout's name as the Desk knows it ("work" finds "Work mode"). */
  name: string;
  /** The windows it left open. */
  windows: string[];
}

/** A saved window layout (JD-37): the built-ins (Work mode, Focus) and Matthew's own. */
export interface LayoutSummary {
  name: string;
  /** The windows it opens (Focus opens none and closes the rest). */
  windows: string[];
}

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

// ── Chat window (JD-29): the one conversation Telegram, the dashboard and the Desk share ──

/** A tool JARVIS used while answering (the chat window's step chips). */
export interface ChatStep {
  name: string;
  summary?: string;
  isError?: boolean;
}

/** One message of the conversation, oldest first in a history page. */
export interface ChatMessage {
  at: string;
  from: "you" | "jarvis";
  channel: BrainChannel;
  text: string;
  /** Replies only. */
  metrics?: BrainMetrics;
  steps?: ChatStep[];
}

/** Replies, tokens and time added up (today's line under the chat window). */
export interface ChatTotals {
  replies: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

/** GET /api/desk/chat/history?before=<ISO>&limit=50: the current conversation, a page at a time. */
export interface ChatHistoryResponse {
  messages: ChatMessage[];
  /** Older messages exist: ask again with before = the first message's `at`. */
  hasMore: boolean;
  model: string;
  models: string[];
  /** Every reply today (Matthew's time zone), across conversations. */
  today: ChatTotals;
}

/** POST /api/desk/chat/model { model } → the model now in use. POST /api/desk/chat/reset {} → { ok }. */
export interface ChatModelResponse {
  model: string;
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
  /** Suggested tasks: why JARVIS proposes it (one line). */
  why?: string;
  createdAt: string;
  /** The row in Notion. */
  url?: string;
}

/** GET /api/desk/tasks?view=… */
export type TaskView = "today" | "upcoming" | "project" | "done" | "suggested";
export interface TasksResponse {
  view: TaskView;
  tasks: TaskItem[];
  /** The JARVIS Tasks database in Notion (once setup has run). */
  notionUrl?: string;
}

/** POST /api/desk/tasks/accept-all: every suggestion made Open. */
export interface AcceptAllResponse {
  accepted: TaskItem[];
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

// ── Today digest (JD-17; made by the worker brain from Calendar, Gmail, Slack, tasks and reports) ──

export interface DigestEvent {
  start: string;
  end: string;
  title: string;
  location?: string;
  link?: string;
  calendar: string;
}

export interface DigestMail {
  from: string;
  subject: string;
  /** Why it's worth reading, in one line. */
  line: string;
  receivedAt: string;
  link?: string;
}

export interface DigestSlack {
  who: string;
  where: string;
  line: string;
  at: string;
  link?: string;
}

export interface DigestSession {
  job: string;
  status: "blocked" | "decision";
  line: string;
  at: string;
  link?: string;
}

export interface Digest {
  generatedAt: string;
  events: DigestEvent[];
  /** Only mail worth reading (max 6). */
  inbox: DigestMail[];
  /** Unread mail left out. */
  skippedCount: number;
  /** Mentions and DMs (max 6). */
  slack: DigestSlack[];
  tasksDue: TaskItem[];
  sessionsWaiting: DigestSession[];
}

/** GET /api/desk/today */
export interface TodayResponse {
  digest?: Digest;
  ageSeconds?: number;
  running: boolean;
  lastError?: string;
}

/** POST /api/desk/brief { channel? }: the brief streams as brain.* events with this messageId, then brief.ready. */
export interface BriefResponse {
  messageId: string;
}

// ── Calendar (JD-21; any range up to 42 days, fetched by the worker brain, cached 10 min) ──

/** focus: focus time / blocks · work: from his work calendar · personal: everything else. */
export type CalendarEventKind = "work" | "personal" | "focus";

export interface CalendarAttendee {
  name: string;
  email: string;
  response: "accepted" | "declined" | "tentative" | "needsAction";
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  /** ISO time; a date (YYYY-MM-DD) for all-day events, whose end is the day after the last day. */
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  location?: string;
  attendees?: CalendarAttendee[];
  description?: string;
  /** Meeting link, or the event's page in Google Calendar. */
  link?: string;
  kind: CalendarEventKind;
}

export interface FreeSlot {
  start: string;
  end: string;
}

export interface CalendarRange {
  range: { start: string; end: string };
  events: CalendarEvent[];
  /** Free slots of ≥ 30 min inside working hours (09:00–18:00, weekdays). */
  free?: FreeSlot[];
}

/** GET /api/desk/calendar?start=&end= (dates or ISO times; a date `end` includes that day). */
export interface CalendarResponse extends CalendarRange {
  ageSeconds: number;
  /** The refresh failed; this is the last good copy. */
  stale?: boolean;
  lastError?: string;
}

/** GET /api/desk/calendar/free?days=7&minMinutes=30 */
export interface CalendarFreeResponse {
  from: string;
  to: string;
  minMinutes: number;
  slots: FreeSlot[];
  ageSeconds: number;
}

// ── Sessions window (JD-32): cloud sessions merged with the ones JARVIS tracks ──

/** needs-you: the latest report is blocked, needs a decision or hands a batch to QA · working: active in the last 30 min · idle: the rest. */
export type SessionGroup = "needs-you" | "working" | "idle";

/** What a session report says (src/notifyRules.ts classifies them). */
export type ReportKind = "blocked" | "decision" | "finished" | "failed" | "info";

export interface DeskSession {
  /** What the other routes take: the tracked name, or the cloud session id for untracked ones. */
  id: string;
  /** The name JARVIS tracks it under (e.g. "mk"); absent for sessions it doesn't track yet. */
  name?: string;
  sessionId: string;
  title: string;
  /** The cloud session's own status (running, idle…), when the list says. */
  status?: string;
  /** The newest of: the session's last event, its last report, the last message sent to it. */
  lastActivity?: string;
  group: SessionGroup;
  /** First line of the latest report, and what kind of report it was. */
  latestReport?: string;
  latestKind?: ReportKind;
  url: string;
}

export interface SessionReport {
  text: string;
  at: string;
  kind: ReportKind;
}

export interface SessionActivityItem {
  at?: string;
  role: "user" | "assistant" | "tool" | "other";
  text: string;
}

/** GET /api/desk/sessions/:id */
export interface SessionDetail {
  session: DeskSession;
  /** What the session has been doing (oldest first); unavailable when its history can't be read. */
  activity: { available: boolean; items: SessionActivityItem[]; reason?: string };
  /** The last 5 reports, newest first. */
  reports: SessionReport[];
  link: string;
}

/** POST /api/desk/sessions/:id/send { text } */
export interface SessionSendResponse {
  ok: true;
  /** The tracked name it went to (an untracked session gets one from its title). */
  name: string;
  ms: number;
}

/** GET /api/desk/usage: how much of the Claude plan is spent (the tray's plan line). */
export interface UsageResponse {
  available: boolean;
  /** Percent (0–100) of the 5-hour window. */
  fiveHour?: number;
  /** Percent (0–100) of the weekly window. */
  weekly?: number;
  reason?: string;
  checkedAt: string;
}

/** A paired Mac, as the dashboard lists it (never includes the key). */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeen?: string;
}

// ── The Mac side of the Desk (JD-26): its own connection to JARVIS and what Settings needs ──

/** Main's live connection to the server (the tray's status dot). */
export interface DeskConnection {
  state: "unconfigured" | "connecting" | "connected" | "offline" | "unauthorized";
  serverUrl?: string;
  /** The paired device's name, from GET /api/desk/me. */
  deviceName?: string;
  error?: string;
}

/** What Settings → Test connection shows. */
export type ConnectionTest = { ok: true; deviceName: string } | { ok: false; error: string };

/** A macOS voice (`say -v ?`). */
export interface VoiceInfo {
  name: string;
  locale: string;
  /** The voice's own sample sentence. */
  sample: string;
}

/** Settings kept in the Keychain, never in settings.json; the renderer can store one but never read it. */
export type DeskSecret = "deviceKey" | "picovoiceKey";

// ── System window (JD-30): the dashboard's tiles, from the server's usage and system monitors ──

/** Brain use over today (server's local day): every reply's tokens (input incl. cache + output), turns and time. */
export interface BrainUsageToday {
  replies: number;
  tokens: number;
  turns: number;
  ms: number;
}

/** GET /api/desk/system */
export interface SystemResponse {
  checkedAt: string;
  /** The Claude plan's allowance spent, 0..100; null when the login doesn't report it. */
  plan: {
    available: boolean;
    fiveHour: number | null;
    weekly: number | null;
    /** When the 5-hour window resets. */
    resetsAt?: string;
    weeklyResetsAt?: string;
    reason?: string;
  };
  /** Routine fires (new cloud jobs) in the last hour against the per-routine cap. */
  fires: { configured: boolean; used: number; limit: number; nextFreeAt?: string };
  /** The container's cgroup readings; bytes, and CPU where 100 = one full core. */
  container: {
    memUsed: number | null;
    memLimit: number | null;
    memPeak: number | null;
    cpu: number | null;
    claudeProcs: number;
    uptimeSeconds: number;
    /** Memory every 10 s over the last hour, oldest first (the sparkline). */
    memHistory: { at: string; memUsed: number | null }[];
  };
  brain: { chatToday: BrainUsageToday; workerToday: BrainUsageToday };
  devices: DeviceInfo[];
}

// ── Notion window (JD-34): search, pinned + recent pages, and a read view of one page ──

/** A page or database as a search result, a pin or a recent entry. Ids are 32 hex chars, no dashes. */
export interface NotionPageRef {
  id: string;
  title: string;
  kind: "page" | "database";
  url?: string;
  /** Last edited (ISO time), when Notion said. */
  editedAt?: string;
  /** JARVIS Tasks and JARVIS Memory: always pinned, can't be unpinned. */
  fixed?: boolean;
}

/** GET /api/desk/notion/search?q= (an empty q lists recently edited pages) */
export interface NotionSearchResponse {
  query: string;
  results: NotionPageRef[];
}

export type NotionBlockType =
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "paragraph"
  | "bulleted"
  | "numbered"
  | "todo"
  | "toggle"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "child_page"
  | "child_database";

/** One block of a page, as plain text; list items and toggles carry their nested blocks. */
export interface NotionBlock {
  id: string;
  type: NotionBlockType;
  text?: string;
  /** To-dos. */
  checked?: boolean;
  /** Code blocks. */
  language?: string;
  /** Callouts: their emoji. */
  icon?: string;
  /** child_page / child_database: the title (the block's id is the page's id). */
  title?: string;
  children?: NotionBlock[];
}

/** GET /api/desk/notion/page/:id (a database reads as its rows, each a child_page block) */
export interface NotionPage extends NotionPageRef {
  /** Every non-empty property but the title, as short text. */
  properties: { name: string; value: string }[];
  blocks: NotionBlock[];
  /** True when the page was longer than the server reads (400 blocks). */
  truncated?: boolean;
}

/**
 * GET /api/desk/notion/pinned → JARVIS Tasks, JARVIS Memory and Matthew's pins, plus the last 10
 * pages opened. POST /notion/pinned/:id { title?, kind? } pins; DELETE (or POST …/:id/unpin, for the
 * bridge's GET/POST) unpins. Each answers the new state.
 */
export interface NotionPinnedResponse {
  pinned: NotionPageRef[];
  recent: NotionPageRef[];
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
  /**
   * Talk to JARVIS; the reply arrives through subscribe() as brain.* events with this messageId.
   * Attachments are upload ids from files.upload (JD-40).
   */
  chat(text: string, channel?: ChatRequest["channel"], attachments?: string[]): Promise<ChatResponse>;
  /**
   * Opens (or focuses) one of the Desk's windows by feature id. Params reach the window as its hash
   * query (`#/sessions?id=mk`), e.g. which session the Sessions window selects (JD-32).
   */
  openWindow(id: string, params?: Record<string, string>): void;
  /** The Desk's settings (desk/main/settingsSchema.ts). A secret's get answers true when one is stored. */
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** The overlay window (JD-19): click-through except where the renderer says it's interactive. */
  overlay?: {
    /** True while the pointer is over the orb (or another interactive region): clicks land on JARVIS. */
    setInteractive(on: boolean): void;
    /** The orb was clicked (the overlay opens its launcher ring itself). */
    orbClicked(): void;
  };
  /** Voice input (JD-31): starts listening as if the hotkey was pressed. Absent until voice is set up. */
  voice?: {
    pushToTalk(): void;
  };
  /** The Mac itself (JD-26): connection status, Keychain secrets, voices, folder picker. */
  mac?: {
    connection(): Promise<DeskConnection>;
    /** Asks the server who this device is, with the saved URL and key. */
    testConnection(): Promise<ConnectionTest>;
    /** Stores the clipboard as a secret (main reads it, so the key never passes through a page). */
    pasteSecret(key: DeskSecret): Promise<void>;
    clearSecret(key: DeskSecret): Promise<void>;
    voices(): Promise<VoiceInfo[]>;
    /** Speaks with `say` (rate in words per minute); a new call stops the previous one. */
    speak(text: string, voice: string, rate: number): Promise<void>;
    /** The macOS folder picker; undefined when cancelled. */
    pickFolder(): Promise<string | undefined>;
  };
  /** Saved window layouts (JD-37): applying one opens, moves and closes windows. Absent in the preview. */
  layouts?: {
    list(): Promise<LayoutSummary[]>;
    apply(name: string): Promise<void>;
  };
  /**
   * Files dropped on the orb or a window (JD-40): main uploads them to POST /api/desk/files (HEIC as
   * JPEG). Progress is 0…1; rejects with a readable sentence (too big, wrong type, the server's error).
   */
  files?: {
    upload(file: File, onProgress?: (fraction: number) => void): Promise<UploadResponse>;
  };
  /** The window this renderer is in (JD-20): the frame's minimise and close buttons. */
  frame?: {
    minimize(): void;
    close(): void;
  };
  /**
   * Full views (JD-39): the real claude.ai session or notion.so page laid over a rect of this window
   * (CSS px from its top-left), signed in through a login shared by every window. show() again with
   * the same url only moves it; hide() keeps it loaded. Absent in the web preview.
   */
  webview?: {
    show(url: string, bounds: { x: number; y: number; width: number; height: number }): void;
    hide(): void;
  };
}

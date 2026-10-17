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
  /** `id`: a notice that card.dismiss can take away again (JD-60's questions, once answered elsewhere). */
  | { type: "notice"; id?: string; at: string; level: NoticeLevel; title: string; body?: string; link?: string; actions?: NoticeAction[] }
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
  /** Something in the agent graph changed (JD-57): a status, CI, a new or gone node; ids are node ids (project:, session:, sub:, ticket:); re-fetch /agents. */
  | { type: "agents.changed"; ids: string[] }
  /** A Desk setting changed on this Mac (main → its windows; never from the server): re-read it with settings.get. */
  | { type: "settings.changed"; key: string }
  /** The server asks the Mac for something (a file, the clipboard…); the Desk answers with POST /api/desk/rpc/:id. */
  | { type: "rpc"; id: string; kind: string; payload: unknown }
  /** The Mac's browser changed (main → the Browser window, JD-59; never from the server). */
  | { type: "browser.state"; state: BrowserState }
  /** JARVIS is about to act in the browser: the window's caption, and the element it will touch. */
  | { type: "browser.action"; caption: string; ref?: number; rect?: BrowserRect }
  /** A browser task changed (JD-60): started, a new step, a question for Matthew, paused, done… */
  | { type: "browser.task"; task: BrowserTaskSummary }
  /** Say this out loud (a browser task's question or result, when the task was asked by voice). */
  | { type: "browser.say"; text: string };

/** A button on a notice's card (JD-27): opens a Desk window or a link; neither just dismisses ("Later"). */
export interface NoticeAction {
  label: string;
  /** A Desk window id (openWindow), with its params, e.g. { window: "sessions", params: { id: "mk" } }. */
  window?: string;
  params?: Record<string, string>;
  url?: string;
  /** A Desk API call instead (JD-60's Approve / Stop on a browser task's question). */
  request?: { path: string; body?: Record<string, unknown> };
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

// Screen awareness and clipboard help (JD-44): only when Matthew asks. The Desk captures the display
// under the pointer (overlay hidden for the shot) or reads the clipboard, uploads images through
// POST /api/desk/files and answers with the upload, so the brain Reads it like an attachment.

/** rpc "screen.capture": payload {}, result ScreenCaptureResult. */
export const SCREEN_RPC = "screen.capture";
/** rpc "clipboard.read": payload {}, result ClipboardReadResult. */
export const CLIPBOARD_RPC = "clipboard.read";
/** Clipboard text longer than this is cut (and says so). */
export const CLIPBOARD_MAX_CHARS = 20_000;

export interface ScreenCaptureResult {
  upload: UploadResponse;
  /** The captured display's size in points. */
  width: number;
  height: number;
}

export type ClipboardReadResult =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; upload: UploadResponse }
  | { kind: "empty" };

// The Mac's browser (JD-59): a Browser window with its own profile that JARVIS acts in through the
// rpc kinds below, done in main over the page's DevTools protocol. Every action answers with the page
// it left (BrowserActionResult). While Matthew has taken over, each one is refused with
// BROWSER_TAKEN_OVER and the brain waits until he hands back.

export const BROWSER_RPC = {
  /** BrowserOpenRequest */
  open: "browser.open",
  /** BrowserNavigateRequest */
  navigate: "browser.navigate",
  /** BrowserTabsRequest; the result carries `tabs`. */
  tabs: "browser.tabs",
  /** BrowserSnapshotRequest → BrowserSnapshotResult */
  snapshot: "browser.snapshot",
  /** BrowserClickRequest */
  click: "browser.click",
  /** BrowserTypeRequest */
  type: "browser.type",
  /** BrowserSelectRequest */
  select: "browser.select",
  /** BrowserPressRequest */
  press: "browser.press",
  /** BrowserScrollRequest */
  scroll: "browser.scroll",
  /** BrowserWaitRequest */
  wait: "browser.wait",
  /** {} → BrowserScreenshotResult */
  screenshot: "browser.screenshot",
  /** BrowserStatusRequest: the task's status line in the window's toolbar. */
  status: "browser.status",
} as const;
export type BrowserRpcKind = (typeof BROWSER_RPC)[keyof typeof BROWSER_RPC];

/** The refusal while Matthew has the browser. */
export const BROWSER_TAKEN_OVER = "Matthew has the browser";
/** A snapshot page is about this long; the rest comes with `more`. */
export const BROWSER_SNAPSHOT_MAX_CHARS = 12_000;
export const BROWSER_WAIT_MAX_MS = 15_000;
export const BROWSER_SCREENSHOT_MAX_BYTES = 300 * 1024;

export interface BrowserOpenRequest {
  /** http(s); a bare host ("example.com") gets https. */
  url: string;
  newTab?: boolean;
}

export interface BrowserNavigateRequest {
  action: "back" | "forward" | "reload";
}

export interface BrowserTabsRequest {
  action: "list" | "switch" | "close";
  /** switch / close: a tab id from the list. */
  tabId?: string;
}

export interface BrowserSnapshotRequest {
  /** The `more` cursor of the previous snapshot: the next part of the same page. */
  more?: string;
}

/** Refs are the numbers in the snapshot ("[12] button …"), valid until the page changes document. */
export interface BrowserClickRequest {
  ref: number;
  /** The browser task this click belongs to (JD-60): the Mac's risky-action guard checks it. */
  task?: BrowserTaskGrant;
}

export interface BrowserTypeRequest {
  ref: number;
  /** Replaces what the field holds. */
  text: string;
  /** Presses Enter afterwards. */
  submit?: boolean;
  task?: BrowserTaskGrant;
}

export interface BrowserSelectRequest {
  ref: number;
  /** The option's label or value. */
  option: string;
}

export interface BrowserPressRequest {
  /** A key name ("Enter", "Escape", "ArrowDown", "Tab", "a"), optionally with modifiers ("Meta+a"). */
  key: string;
}

export interface BrowserScrollRequest {
  /** By most of a screen, or to an end. */
  direction?: "up" | "down" | "top" | "bottom";
  /** Scrolls this element into view instead. */
  ref?: number;
}

export interface BrowserWaitRequest {
  /** Until this text is on the page (case-insensitive). */
  text?: string;
  /** Or just this long. Either way at most BROWSER_WAIT_MAX_MS. */
  ms?: number;
}

export interface BrowserStatusRequest {
  /** One line, e.g. "Booking a table for 4 · checking Friday"; empty clears it. */
  text?: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** What every browser action answers: where the page is now, and whether the action changed it. */
export interface BrowserActionResult {
  url: string;
  title: string;
  change: "page changed" | "same page";
  /** browser.tabs and browser.open: every tab. */
  tabs?: BrowserTab[];
}

export interface BrowserSnapshotResult extends BrowserActionResult {
  /** The page as an accessibility tree, one element a line; interactive ones carry a [ref]. */
  text: string;
  /** Ask again with this for the next part of the page. */
  more?: string;
}

export interface BrowserScreenshotResult extends BrowserActionResult {
  /** The viewport as a JPEG (at most BROWSER_SCREENSHOT_MAX_BYTES), uploaded like a dropped file. */
  upload: UploadResponse;
  width: number;
  height: number;
}

/** In CSS px from the page's top-left (the viewport). */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Who drives the browser: JARVIS acts; Matthew, after Take over, and JARVIS waits. */
export type BrowserControl = "jarvis" | "matthew";

/** The Browser window's toolbar and tab strip. */
export interface BrowserState {
  tabs: BrowserTab[];
  /** The active tab's page ("" with no tabs). */
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  control: BrowserControl;
  /** The task's status line (browser.status). */
  status?: string;
}

/** What the Browser window's toolbar and tab strip ask main to do (Matthew's own clicks). */
export type BrowserCommand =
  | { type: "go"; address: string }
  | {
      type:
        "back" | "forward" | "reload" | "new-tab" | "take-over" | "hand-back";
    }
  | { type: "switch-tab" | "close-tab"; tabId: string };

// Browser tasks (JD-60): Matthew asks for something on the web ("book a table at Lilia for Friday 8pm
// for 2") from the Browser window's task box, chat, voice or Telegram; the server runs it on its own
// worker conversation with the browser_* tools, which call the browser.* rpc kinds above. Normal mode
// asks Matthew before a step that buys, books, sends, posts, deletes or changes account settings; Full
// autonomy doesn't. Both stop for passwords, one-time codes and card details: Matthew types those
// himself (Take over, then Hand back). The Mac checks clicks and typing too (main/browser/guard.ts).

/** Normal asks before risky steps; full doesn't. Chosen per task; Normal unless asked. */
export type BrowserTaskMode = "normal" | "full";

/** What the server sends with a click or typing in a task: the mode, and Matthew's approval for this step. */
export interface BrowserTaskGrant {
  taskId: string;
  mode: BrowserTaskMode;
  /** The token from Matthew's Approve (single use; the server checks it before sending). */
  approval?: string;
}

/** The Mac's refusals (the start of the rpc error): Normal mode without an approval, and a secret field. */
export const BROWSER_NEEDS_APPROVAL = "Needs Matthew's approval";
export const BROWSER_NEEDS_MATTHEW = "Matthew types this himself";

/** Where the task was asked, so the result goes back there (and is spoken when it came by voice). */
export type BrowserTaskOrigin = "browser" | "desk-typed" | "desk-voice" | "telegram" | "dashboard";

export type BrowserTaskStatus = "running" | "waiting" | "paused" | "done" | "stopped" | "failed";

/** What a waiting task asks Matthew: approve a risky step, answer a question, or type a secret himself. */
export interface BrowserTaskQuestion {
  id: string;
  kind: "approval" | "question" | "takeover";
  text: string;
  at: string;
}

/** One line of a task's log (kept 30 days): what JARVIS did, where, and what Matthew answered. */
export interface BrowserTaskStep {
  at: string;
  kind: "start" | "action" | "ask" | "answer" | "approval" | "refused" | "pause" | "resume" | "done" | "stop" | "error";
  text: string;
  url?: string;
}

export interface BrowserTaskSummary {
  id: string;
  /** What Matthew asked for. */
  text: string;
  mode: BrowserTaskMode;
  status: BrowserTaskStatus;
  origin: BrowserTaskOrigin;
  startedAt: string;
  endedAt?: string;
  /** The current step (the Browser window's status line). */
  step?: string;
  question?: BrowserTaskQuestion;
  /** browser_done's summary, or why it stopped. */
  result?: string;
  /** How many steps the log holds. */
  steps: number;
}

export interface BrowserTask extends BrowserTaskSummary {
  log: BrowserTaskStep[];
}

/** POST /api/desk/browser/tasks → BrowserTaskSummary. `mode` from the task box's switch. */
export interface BrowserTaskStartRequest {
  text: string;
  mode?: BrowserTaskMode;
}

/** GET /api/desk/browser/tasks: the last 30 days, newest first (the History menu). */
export interface BrowserTasksResponse {
  tasks: BrowserTaskSummary[];
}

/** POST /api/desk/browser/tasks/:id/answer → BrowserTaskSummary. "change" and "reply" carry text. */
export interface BrowserTaskAnswerRequest {
  questionId: string;
  answer: "approve" | "change" | "stop" | "reply";
  text?: string;
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
  /** The model for this turn (JD-48: Settings → voiceModel for voice turns); default the chat's model. */
  model?: string;
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
  /** What the session has used (JD-53); absent when its detail couldn't be read. */
  metrics?: SessionMetrics;
}

/** The sessions API's status bucket, lower-cased without its prefix ("working", "completed"…). */
export type SessionStatusBucket = "working" | "blocked" | "review_ready" | "completed" | "failed" | (string & {});

/**
 * Per-session metrics (JD-53) from the cloud session's detail and events. Every value the API
 * didn't give is undefined (unknown), never 0. Turns, tool calls, PRs and active time are only on
 * GET /api/desk/sessions/:id.
 */
export interface SessionMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** input + output + cache read + cache write, when all four are known. */
  totalTokens?: number;
  costUsd?: number;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  /** used / max × 100, rounded to one decimal. */
  contextPercent?: number;
  /** The model the latest turn ran on, else the configured one. */
  model?: string;
  /** The configured model, only when the latest turn was served by a different one (JD-54). */
  configuredModel?: string;
  statusBucket?: SessionStatusBucket;
  tags?: string[];
  /** The session that started this one, when the lineage names it. */
  parentId?: string;
  /** The GitHub repository it runs on ("owner/name"), from its session context (JD-55). */
  repo?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Now − created, or last activity − created once the session is finished. */
  wallMs?: number;
  /** Completed: its metrics no longer change and aren't re-read. */
  finished?: boolean;
  /** Detail only: user messages (turns) sent to the session. */
  turns?: number;
  /** Detail only: tool calls the session made. */
  toolCalls?: number;
  /** Detail only: GitHub PR links seen in tool results, oldest first. */
  prs?: string[];
  /** Detail only: the sum of turn durations (each turn's start to its result; an open turn counts to now). */
  activeMs?: number;
  /** Detail only: the history was longer than one read covers, so the activity counts are a lower bound. */
  activityPartial?: boolean;
  /** When these were read from the API (older than the request when the API is failing). */
  checkedAt: string;
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
  /** Voice latency over the last voice turns the Desk reported (JD-48); absent on an older server. */
  voiceLatency?: VoiceLatencySummary;
  /** Cloud sessions' use per project, most expensive first (JD-55); absent on an older server. */
  projects?: ProjectUsage[];
  /** The last 30 days of cloud session use, oldest first, split by project (JD-55). */
  history?: UsageDay[];
}

// ── Project totals and history (JD-55): cloud session use from the server's hourly snapshots ──

/** What a project's sessions used over a period; tokens = input + output + cache read + cache write. */
export interface ProjectUsagePeriod {
  costUsd: number;
  tokens: number;
  /** Sessions that used anything in the period. */
  sessions: number;
  /** Their wall time (created → last activity, or now) inside the period. */
  wallMs: number;
  /** Their turns' time inside the period. */
  activeMs: number;
}

export interface ProjectUsage {
  /** The session's `project:<name>` tag, else its repository's name, else "Other". */
  project: string;
  /** Sessions working at the last snapshot. */
  activeSessions: number;
  /** The last 7 days, today included. */
  week: ProjectUsagePeriod;
  allTime: ProjectUsagePeriod;
}

export interface UsageDay {
  /** YYYY-MM-DD in the server's time zone. */
  day: string;
  costUsd: number;
  tokens: number;
  /** The day's use per project (only the projects that used something). */
  projects: Record<string, { costUsd: number; tokens: number }>;
}

// ── Voice latency (JD-48): how long from Matthew's last word to JARVIS's first ──

/**
 * One voice turn's stages, as ms after the end of speech (the last speech frame). A stage the turn
 * never reached is absent (cancelled, nothing heard, an error, spoken replies off).
 *   endpoint: the endpointer decided he'd finished (its silence wait) · transcript: Whisper done ·
 *   sent: POST /chat went out · accepted: the server answered with the messageId · firstDelta: the
 *   reply's first brain.delta · firstSentence: the first sentence (or clause) complete · sayReady:
 *   `say` has written it · audioStart: afplay started = the first word heard.
 */
export interface VoiceLatencyStages {
  endpoint?: number;
  transcript?: number;
  sent?: number;
  accepted?: number;
  firstDelta?: number;
  firstSentence?: number;
  sayReady?: number;
  audioStart?: number;
}

export type VoiceLatencyStage = keyof VoiceLatencyStages;

/** POST /api/desk/system/latency (the Desk, after every voice turn) → { ok: true } */
export interface VoiceLatencyTurn {
  /** When speech ended (ISO). */
  at: string;
  /** Push-to-talk (hotkey, tray, Chat's mic) or the wake word. */
  trigger: "ptt" | "wake";
  /** How long Matthew spoke. */
  speechMs: number;
  /** The model asked (Settings → voiceModel, or the chat's). */
  model?: string;
  stages: VoiceLatencyStages;
}

/** p50/p90 over the last 20 turns that reached audioStart; each stage's p50 shows where time goes. */
export interface VoiceLatencySummary {
  /** Turns with a first word among the last 20 reported. */
  turns: number;
  /** ms from the end of speech to the first word; null with no turns yet. */
  p50: number | null;
  p90: number | null;
  /** Each stage's median, in pipeline order (only stages some turn reached). */
  stages: { stage: VoiceLatencyStage; p50: number }[];
  /** The most recent turn reported (also one that never got to a first word). */
  last?: VoiceLatencyTurn;
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

// ── Agent graph (JD-57): projects → orchestrators → builders, with tickets, PRs and live CI ──
// Built from session tags (project:, role:, orchestrator:, ticket:, run:), session lineage, the run
// page's Builders table, the projects' Tickets databases and `<ID>: …` session titles, in that order:
// an earlier source wins, a later one fills gaps.

/** Where a node's facts came from. */
export type AgentSource = "tags" | "lineage" | "run-page" | "ticket" | "title";

/** A cloud session in the graph (an orchestrator, or a builder that is one). */
export interface AgentSession {
  id: string;
  title: string;
  url: string;
  /** The session list's status (running, idle…). */
  status?: string;
  lastActivity?: string;
  /** Its JD-53 metrics (statusBucket, cost, tokens…); absent when the detail couldn't be read. */
  metrics?: SessionMetrics;
}

export interface AgentTicket {
  /** e.g. "JD-57". */
  id: string;
  title?: string;
  /** The ticket page's Status (In Progress, In Review, QA Pending…). */
  status?: string;
  url?: string;
}

/** CI for a PR's head commit, from GitHub check runs. Failed beats running beats queued beats passed. */
export type CiState = "queued" | "running" | "passed" | "failed";

export interface AgentCheck {
  name: string;
  /** GitHub's own: queued, in_progress, completed (or waiting, requested, pending). */
  status: string;
  /** Set once completed: success, failure, neutral, cancelled, skipped, timed_out, action_required… */
  conclusion?: string;
  url?: string;
  state: CiState;
}

export interface AgentCi {
  state: CiState;
  checks: AgentCheck[];
  headSha?: string;
  checkedAt: string;
}

export interface AgentPr {
  number: number;
  url: string;
  /** owner/name, from the PR URL. */
  repo: string;
  /** From GitHub once read; until then what the run page or ticket implies (open). */
  state: "open" | "closed" | "merged";
  title?: string;
}

/**
 * One builder: a cloud session, a sub-agent row from the run page (a local worktree no session API
 * sees), or a ticket in progress that nothing else accounts for.
 */
export interface AgentBuilder {
  /** "session:<id>", "sub:<run>:<ticket or worktree>" or "ticket:<ID>". */
  id: string;
  kind: "cloud" | "sub-agent" | "ticket";
  session?: AgentSession;
  /** The run page's Session / worktree cell when it names no session JARVIS can see (a worktree path). */
  worktree?: string;
  /** The run page's State: building, CI, merged, blocked, stopped. */
  state?: string;
  ticket?: AgentTicket;
  pr?: AgentPr;
  ci?: AgentCi;
  /** From the run page (HH:MM UTC on the run's day, as ISO). */
  startedAt?: string;
  updatedAt?: string;
  sources: AgentSource[];
}

/** The orchestrator's run page (`Run: <project> <scope> (<date>)`). */
export interface AgentRun {
  /** The page id (32 hex), as in the run: tag. */
  id: string;
  url: string;
  title?: string;
  /** The callout's Status: Running, Waiting on user, Handed over, Finished. */
  status?: string;
}

/** Totals over a node and everything under it; cost and tokens only from sessions that report them. */
export interface AgentMetrics {
  sessions: number;
  builders: number;
  /** Builders still working: not finished, and not merged or stopped on the run page. */
  active: number;
  costUsd?: number;
  totalTokens?: number;
}

export interface AgentOrchestrator {
  /** "session:<id>". */
  id: string;
  session: AgentSession;
  metrics: AgentMetrics;
  run?: AgentRun;
  /** Its session has completed (or its run page says Finished). */
  finished: boolean;
  builders: AgentBuilder[];
}

export interface AgentProject {
  /** "project:<slug>". */
  id: string;
  slug: string;
  name: string;
  notionUrl?: string;
  /** owner/name. */
  repo?: string;
  /** Including folded runs. */
  metrics: AgentMetrics;
  orchestrators: AgentOrchestrator[];
  /** Builders and tagged sessions under no orchestrator. */
  loose: AgentBuilder[];
  /** Finished runs older than 7 days left out of `orchestrators` (GET /agents?all=1 returns them). */
  folded: number;
}

/** GET /api/desk/agents[?all=1]; agents.changed says when to fetch it again. */
export interface AgentsResponse {
  projects: AgentProject[];
  /** What couldn't be read this time (Notion, GitHub, the session list), one line each. */
  warnings: string[];
  checkedAt: string;
}

// ── The Desk bridge (window.desk): the renderer's only door to the rest of the app ──
// In Electron, preload implements it over IPC and main talks to the server; in the web preview
// (and e2e) a mock implements it from a scenario (desk/renderer/mock/). Features extend it.

/** A Desk window under a pinch (JD-47), in the asking window's coordinates (CSS px from its top-left). */
export interface HandWindow {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** The feature's smallest size: a two-hand resize stops there. */
  minSize: { width: number; height: number };
}

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
    /** Settings → Test (JD-45): cycles the four orb states through the status files; throws without a folder. */
    testStatusFiles(): Promise<void>;
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
  /**
   * The Mac's browser (JD-59): its toolbar state (then browser.state events), Matthew's toolbar
   * commands, and the rect of this window the active page is laid over (like webview).
   */
  browser?: {
    state(): Promise<BrowserState>;
    command(command: BrowserCommand): Promise<void>;
    show(bounds: { x: number; y: number; width: number; height: number }): void;
    hide(): void;
  };
  /**
   * Camera-hand gestures on Desk windows (JD-47), for the overlay: which window is at a point (its
   * title bar, or anywhere on it), and moving, resizing or minimising it. Coordinates are the overlay's.
   * `done` marks a gesture's last move, when the bounds are saved. Absent in the web preview.
   */
  hands?: {
    windowAt(point: { x: number; y: number }, part: "titlebar" | "any"): Promise<HandWindow | undefined>;
    setBounds(id: string, bounds: { x: number; y: number; width: number; height: number }, done?: boolean): void;
    minimize(id: string): void;
  };
}

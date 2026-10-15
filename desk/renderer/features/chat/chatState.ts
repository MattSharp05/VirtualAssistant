// The chat window's timeline (mockup 3): history pages from the server, live brain.* events from any
// channel (Telegram and the dashboard too, it's one conversation), the reply streaming in, and calendar
// changes inline. A pure reducer, so the logic is tested without React.
import type {
  BrainChannel,
  BrainMetrics,
  CalendarChange,
  ChatMessage,
  ChatStep,
  ChatTotals,
  DeskEvent,
} from "@jarvis/shared";

export interface MessageItem {
  kind: "message";
  /** `u:<messageId>` / `r:<messageId>` for live turns, `h:<n>` from history, `local:<n>` while sending. */
  key: string;
  from: "you" | "jarvis";
  channel: BrainChannel;
  text: string;
  at: string;
  metrics?: BrainMetrics;
  steps: ChatStep[];
  /** Names of the files sent with it (dropped on the window, JD-40). */
  files?: string[];
  /** The reply is still being written. */
  streaming?: boolean;
  error?: string;
}

export interface CalendarItem {
  kind: "calendar";
  key: string;
  change: CalendarChange;
  /** Undone since (by an undo_calendar_change turn). */
  undone: boolean;
}

export type ChatItem = MessageItem | CalendarItem;

export interface ChatState {
  items: ChatItem[];
  /** Older messages exist on the server. */
  hasMore: boolean;
  today: ChatTotals;
  /** The `at` of the oldest message loaded (the next page's `before`). */
  oldest?: string;
  nextKey: number;
}

export const emptyTotals = (): ChatTotals => ({ replies: 0, inputTokens: 0, outputTokens: 0, ms: 0 });

export const initialChat = (): ChatState => ({ items: [], hasMore: false, today: emptyTotals(), nextKey: 0 });

export type ChatAction =
  | { type: "history"; messages: ChatMessage[]; hasMore: boolean; today?: ChatTotals }
  | { type: "sent"; key: string; text: string; at: string; files?: string[] }
  | { type: "acked"; key: string; messageId: string }
  | { type: "failed"; key: string; error: string }
  | { type: "reset" }
  | { type: "event"; event: DeskEvent; at: string };

const isMessage = (i: ChatItem): i is MessageItem => i.kind === "message";

function updateMessage(state: ChatState, key: string, fn: (m: MessageItem) => MessageItem): ChatState {
  return { ...state, items: state.items.map((i) => (i.key === key && isMessage(i) ? fn(i) : i)) };
}

/** The reply bubble for a turn, created when its first delta or tool step arrives. */
function withReply(state: ChatState, messageId: string, at: string, fn: (m: MessageItem) => MessageItem) {
  const key = `r:${messageId}`;
  if (state.items.some((i) => i.key === key)) return updateMessage(state, key, fn);
  const turn = state.items.find((i): i is MessageItem => i.key === `u:${messageId}` && isMessage(i));
  const reply: MessageItem = {
    kind: "message",
    key,
    from: "jarvis",
    channel: turn?.channel ?? "desk-typed",
    text: "",
    at,
    steps: [],
    streaming: true,
  };
  return { ...state, items: [...state.items, fn(reply)] };
}

function onEvent(state: ChatState, e: DeskEvent, at: string): ChatState {
  switch (e.type) {
    case "brain.start": {
      if (state.items.some((i) => i.key === `u:${e.messageId}`)) return state;
      const mine: MessageItem = {
        kind: "message",
        key: `u:${e.messageId}`,
        from: "you",
        channel: e.channel,
        text: e.text,
        at,
        steps: [],
      };
      return { ...state, items: [...state.items, mine] };
    }
    case "brain.delta":
      return withReply(state, e.messageId, at, (m) => ({ ...m, text: m.text + e.text }));
    case "brain.tool":
      return withReply(state, e.messageId, at, (m) => {
        if (e.phase === "call") return { ...m, steps: [...m.steps, { name: e.name }] };
        // The result completes the latest call of that tool.
        const i = m.steps.findLastIndex((s) => s.name === e.name && s.summary === undefined);
        const step: ChatStep = {
          name: e.name,
          summary: e.summary ?? "",
          ...(e.isError ? { isError: true } : {}),
        };
        const steps = i < 0 ? [...m.steps, step] : m.steps.map((s, j) => (j === i ? step : s));
        return { ...m, steps };
      });
    case "brain.done": {
      const next = withReply(state, e.messageId, at, (m) => ({
        ...m,
        text: e.text,
        metrics: e.metrics,
        streaming: false,
      }));
      const t = e.metrics;
      return {
        ...next,
        today: {
          replies: next.today.replies + 1,
          inputTokens: next.today.inputTokens + t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens,
          outputTokens: next.today.outputTokens + t.outputTokens,
          ms: next.today.ms + t.ms,
        },
      };
    }
    case "brain.error":
      return withReply(state, e.messageId, at, (m) => ({ ...m, streaming: false, error: e.error }));
    case "calendar.changed": {
      const items = state.items.map((i) =>
        i.kind === "calendar" && i.change.id === e.entry.undoOf ? { ...i, undone: true } : i,
      );
      const line: CalendarItem = {
        kind: "calendar",
        key: `c:${e.entry.id}`,
        change: e.entry,
        undone: Boolean(e.entry.undoneAt),
      };
      return { ...state, items: [...items, line] };
    }
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "history": {
      let n = state.nextKey;
      const older: MessageItem[] = action.messages.map((m) => ({
        kind: "message",
        key: `h:${n++}`,
        from: m.from,
        channel: m.channel,
        text: m.text,
        at: m.at,
        steps: m.steps ?? [],
        ...(m.metrics ? { metrics: m.metrics } : {}),
      }));
      return {
        ...state,
        items: [...older, ...state.items],
        hasMore: action.hasMore,
        oldest: action.messages[0]?.at ?? state.oldest,
        nextKey: n,
        today: action.today ?? state.today,
      };
    }
    case "sent": {
      const mine: MessageItem = {
        kind: "message",
        key: action.key,
        from: "you",
        channel: "desk-typed",
        text: action.text,
        at: action.at,
        steps: [],
        ...(action.files?.length ? { files: action.files } : {}),
      };
      return { ...state, items: [...state.items, mine] };
    }
    case "acked": {
      // brain.start can beat the POST's answer; then the live copy stays and the local one goes.
      const live = `u:${action.messageId}`;
      if (state.items.some((i) => i.key === live))
        return { ...state, items: state.items.filter((i) => i.key !== action.key) };
      return { ...state, items: state.items.map((i) => (i.key === action.key ? { ...i, key: live } : i)) };
    }
    case "failed":
      return updateMessage(state, action.key, (m) => ({ ...m, error: action.error }));
    case "reset":
      return { ...state, items: [], hasMore: false, oldest: undefined };
    case "event":
      return onEvent(state, action.event, action.at);
  }
}

// ── Formatting (the mockup's meta lines) ──

/** "sonnet" from "claude-sonnet-5-5". */
export const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/-\d.*$/, "");

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** "⏱ 4.2s · 🔢 18k in (16k cached) · 212 out · sonnet · 3 steps": the same line Telegram shows. */
export function formatMetrics(m: BrainMetrics): string {
  const input = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
  return `⏱ ${(m.ms / 1000).toFixed(1)}s · 🔢 ${k(input)} in (${k(m.cacheReadTokens)} cached) · ${k(m.outputTokens)} out · ${shortModel(m.model)}${m.turns > 1 ? ` · ${m.turns} steps` : ""}`;
}

const CHANNEL_LABEL: Record<BrainChannel, string> = {
  "desk-voice": "🎙 voice",
  "desk-typed": "⌨ typed",
  telegram: "Telegram",
  dashboard: "dashboard",
  worker: "worker",
};

export const channelLabel = (c: BrainChannel) => CHANNEL_LABEL[c] ?? c;

/** "09:04" in the Mac's time zone. */
export const clock = (at: string) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "Today: 14 replies · 182k in · 3.1k out · avg 4.8s". */
export function formatToday(t: ChatTotals): string {
  if (t.replies === 0) return "Today: no replies yet";
  const avg = (t.ms / t.replies / 1000).toFixed(1);
  return `Today: ${t.replies} ${t.replies === 1 ? "reply" : "replies"} · ${k(t.inputTokens)} in · ${k(t.outputTokens)} out · avg ${avg}s`;
}

/** A tool's chip text: "slack search public" from "mcp__claude_ai_Slack__slack_search_public". */
export const stepLabel = (name: string) => name.replace(/^mcp__.*?__/, "").replace(/_/g, " ");

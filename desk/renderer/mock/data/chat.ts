// The chat window's conversation (JD-29, mockup 3): typed as the server's history so the preview and the
// real thing match. Voice, typed and Telegram turns, tool steps, metrics, and a calendar change that
// arrives live with its Undo link.
import type { BrainMetrics, ChatHistoryResponse, DeskEvent } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const sonnet = (ms: number, input: number, cached: number, out: number, turns: number): BrainMetrics => ({
  ms,
  model: "claude-sonnet-5-5",
  inputTokens: input - cached,
  cacheReadTokens: cached,
  cacheWriteTokens: 0,
  outputTokens: out,
  turns,
});

export const chatHistory: ChatHistoryResponse = {
  model: "claude-sonnet-5-5",
  models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  hasMore: false,
  today: { replies: 14, inputTokens: 182_000, outputTokens: 3_100, ms: 67_200 },
  messages: [
    {
      at: "2026-10-14T08:58:00Z",
      from: "you",
      channel: "desk-voice",
      text: "what did I miss on Slack this morning?",
    },
    {
      at: "2026-10-14T08:58:05Z",
      from: "jarvis",
      channel: "desk-voice",
      text: "Two things. Sam asked in #trip whether Friday works for the booking call, and Alex shared the new logo in #design. Nothing urgent.",
      metrics: sonnet(5100, 21_000, 18_000, 96, 3),
      steps: [
        { name: "mcp__claude_ai_Slack__slack_search_public", summary: "6 messages" },
        { name: "mcp__claude_ai_Slack__slack_read_thread", summary: "#trip thread" },
      ],
    },
    { at: "2026-10-14T09:04:00Z", from: "you", channel: "desk-typed", text: "how is mk going?" },
    {
      at: "2026-10-14T09:04:06Z",
      from: "jarvis",
      channel: "desk-typed",
      text: "Wave 3 is 4 of 6 done. MK-81 is blocked: it needs you to decide whether drift boost stays in v1. I added it to your to-dos.",
      metrics: sonnet(6400, 24_000, 20_000, 118, 4),
      steps: [
        { name: "mcp__jarvis__overview", summary: "mk: 4/6 merged" },
        { name: "mcp__jarvis__session_activity", summary: "mk: 12 events" },
        { name: "mcp__jarvis__add_task", summary: "Decide: drift boost in v1?" },
      ],
    },
    {
      at: "2026-10-14T09:07:00Z",
      from: "you",
      channel: "telegram",
      text: "tell mk to keep drift boost but cap it at 1.2x",
    },
    {
      at: "2026-10-14T09:07:04Z",
      from: "jarvis",
      channel: "telegram",
      text: "Sent to mk: “Keep drift boost in v1, capped at 1.2× speed.” Its answer will come back as a report.",
      metrics: sonnet(3900, 19_000, 18_000, 54, 2),
      steps: [{ name: "mcp__jarvis__send_to_session", summary: "sent to mk" }],
    },
  ],
};

/** JARVIS moves a meeting while Matthew watches: the change line with its Undo link. */
export const calendarChange: DeskEvent = {
  type: "calendar.changed",
  entry: {
    id: "cal-1",
    at: "2026-10-14T09:12:00Z",
    tool: "update_event",
    input: { eventId: "e9", start: "2026-10-17T14:00:00" },
    result: "{}",
    summary: "Moved Booking call to Fri 17 Oct 14:00",
  },
};

export const chatData: Record<string, unknown> = {
  "/chat/history?limit=50": chatHistory,
  "/chat/model": (body: { model?: string } | undefined) => ({ model: body?.model ?? chatHistory.model }),
  "/chat/reset": { ok: true },
};

const part: ScenarioPart = {
  data: chatData,
  events: [{ after: 300, event: calendarChange }],
};

export default part;

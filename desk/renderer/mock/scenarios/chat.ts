// The chat window (JD-29) for the preview, e2e and snapshots.
import type { DeskEvent } from "@jarvis/shared";
import chatPart, { chatData, chatHistory } from "../data/chat";
import type { Scenario, TimedEvent } from "../types";

const REPLY = "Done. Friday's booking call is at 14:00 and Sam has the new invite.";

/** A Telegram turn whose reply is still being written when the timeline ends (a step running). */
const streaming: TimedEvent[] = [
  {
    after: 200,
    event: {
      type: "brain.start",
      messageId: "tg-1",
      channel: "telegram",
      text: "is the booking call sorted?",
    },
  },
  {
    after: 100,
    event: { type: "brain.tool", messageId: "tg-1", phase: "call", name: "mcp__jarvis__overview" },
  },
  {
    after: 100,
    event: {
      type: "brain.tool",
      messageId: "tg-1",
      phase: "result",
      name: "mcp__jarvis__overview",
      summary: "trip: 2 events",
    },
  },
  {
    after: 50,
    event: {
      type: "brain.tool",
      messageId: "tg-1",
      phase: "call",
      name: "mcp__claude_ai_Google_Calendar__list_events",
    },
  },
  ...["Yes. ", "It's ", "on ", "Friday ", "at "].map((text): TimedEvent => ({
    after: 60,
    event: { type: "brain.delta", messageId: "tg-1", text } as DeskEvent,
  })),
];

const scenarios: Scenario[] = [
  {
    name: "chat",
    description:
      "Chat: voice, typed and Telegram turns with steps and metrics; JARVIS moves a meeting (Undo).",
    data: chatData,
    events: chatPart.events ?? [],
    chatReply: REPLY,
  },
  {
    name: "chat-empty",
    description: "Chat right after New conversation: nothing yet, today's totals still shown.",
    data: { ...chatData, "/chat/history?limit=50": { ...chatHistory, messages: [] } },
    events: [],
    chatReply: REPLY,
  },
  {
    name: "chat-streaming",
    description: "Chat while a reply to a Telegram message streams in, one step still running.",
    data: chatData,
    events: streaming,
  },
];

export default scenarios;

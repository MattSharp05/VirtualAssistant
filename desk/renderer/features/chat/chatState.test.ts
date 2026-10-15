import { describe, expect, it } from "vitest";
import type { BrainMetrics, DeskEvent } from "@jarvis/shared";
import {
  chatReducer,
  formatMetrics,
  formatToday,
  initialChat,
  shortModel,
  stepLabel,
  type ChatState,
  type MessageItem,
} from "./chatState";

const metrics: BrainMetrics = {
  ms: 4200,
  model: "claude-sonnet-5-5",
  inputTokens: 400,
  cacheReadTokens: 16_000,
  cacheWriteTokens: 2_000,
  outputTokens: 212,
  turns: 3,
};

const at = "2026-10-14T09:00:00Z";
const play = (state: ChatState, ...events: DeskEvent[]) =>
  events.reduce((s, event) => chatReducer(s, { type: "event", event, at }), state);
const messages = (s: ChatState) => s.items.filter((i): i is MessageItem => i.kind === "message");

describe("chat timeline", () => {
  it("streams a turn from any channel: message, steps, deltas, then the final text and metrics", () => {
    const s = play(
      initialChat(),
      { type: "brain.start", messageId: "m1", channel: "telegram", text: "how is mk?" },
      { type: "brain.tool", messageId: "m1", phase: "call", name: "mcp__jarvis__overview" },
      { type: "brain.delta", messageId: "m1", text: "Wave 3 " },
    );
    const [mine, reply] = messages(s);
    expect(mine).toMatchObject({ from: "you", channel: "telegram", text: "how is mk?" });
    expect(reply).toMatchObject({ from: "jarvis", channel: "telegram", text: "Wave 3 ", streaming: true });
    expect(reply.steps).toEqual([{ name: "mcp__jarvis__overview" }]);

    const done = play(
      s,
      { type: "brain.tool", messageId: "m1", phase: "result", name: "mcp__jarvis__overview", summary: "4/6" },
      { type: "brain.done", messageId: "m1", text: "Wave 3 is 4 of 6.", metrics },
    );
    const finished = messages(done)[1];
    expect(finished).toMatchObject({ text: "Wave 3 is 4 of 6.", streaming: false, metrics });
    expect(finished.steps).toEqual([{ name: "mcp__jarvis__overview", summary: "4/6" }]);
    expect(done.today).toEqual({ replies: 1, inputTokens: 18_400, outputTokens: 212, ms: 4200 });
  });

  it("a typed message shows at once and isn't doubled by its brain.start, whichever comes first", () => {
    const sent = chatReducer(initialChat(), { type: "sent", key: "local:1", text: "hi", at });
    const ackFirst = play(chatReducer(sent, { type: "acked", key: "local:1", messageId: "m1" }), {
      type: "brain.start",
      messageId: "m1",
      channel: "desk-typed",
      text: "hi",
    });
    expect(messages(ackFirst).map((m) => m.key)).toEqual(["u:m1"]);
    const startFirst = chatReducer(
      play(sent, { type: "brain.start", messageId: "m1", channel: "desk-typed", text: "hi" }),
      { type: "acked", key: "local:1", messageId: "m1" },
    );
    expect(messages(startFirst).map((m) => m.key)).toEqual(["u:m1"]);
  });

  it("older history pages go above, a reset clears the view, errors stay on their message", () => {
    let s = play(initialChat(), { type: "brain.start", messageId: "m2", channel: "desk-voice", text: "new" });
    s = chatReducer(s, {
      type: "history",
      hasMore: true,
      messages: [{ at: "2026-10-14T08:00:00Z", from: "you", channel: "dashboard", text: "old" }],
    });
    expect(messages(s).map((m) => m.text)).toEqual(["old", "new"]);
    expect(s.oldest).toBe("2026-10-14T08:00:00Z");
    expect(s.hasMore).toBe(true);
    s = play(s, { type: "brain.error", messageId: "m2", error: "timed out" });
    expect(messages(s)[2]).toMatchObject({ error: "timed out", streaming: false });
    expect(chatReducer(s, { type: "reset" }).items).toEqual([]);
  });

  it("calendar changes appear inline and an undo marks the original undone", () => {
    const change = { at, tool: "update_event", input: {}, result: "", summary: "Moved Gym to 18:00" };
    let s = play(initialChat(), { type: "calendar.changed", entry: { ...change, id: "c1" } });
    expect(s.items[0]).toMatchObject({ kind: "calendar", undone: false });
    s = play(s, { type: "calendar.changed", entry: { ...change, id: "c2", undoOf: "c1" } });
    expect(s.items.map((i) => i.kind === "calendar" && [i.change.id, i.undone])).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
  });
});

describe("chat formatting", () => {
  it("matches the Telegram metrics line and the mockup's totals line", () => {
    expect(formatMetrics(metrics)).toBe("⏱ 4.2s · 🔢 18k in (16k cached) · 212 out · sonnet · 3 steps");
    expect(formatToday({ replies: 14, inputTokens: 182_000, outputTokens: 3_100, ms: 67_200 })).toBe(
      "Today: 14 replies · 182k in · 3.1k out · avg 4.8s",
    );
    expect(formatToday({ replies: 0, inputTokens: 0, outputTokens: 0, ms: 0 })).toBe("Today: no replies yet");
  });

  it("shortens model and tool names", () => {
    expect(shortModel("claude-haiku-5-5")).toBe("haiku");
    expect(stepLabel("mcp__claude_ai_Slack__slack_search_public")).toBe("slack search public");
    expect(stepLabel("mcp__jarvis__add_task")).toBe("add task");
    expect(stepLabel("Read")).toBe("Read");
  });
});

// window.desk in the browser: answers requests from the scenario's data, replays its events with
// their timings, and streams a canned chat reply as brain.* events (like the real server does).
import { PROTOCOL_VERSION, type ChatResponse, type DeskBridge, type DeskEvent } from "@jarvis/shared";
import type { Scenario } from "./types";

const WORD_MS = 60;

export interface MockBridge extends DeskBridge {
  /** Stops pending timers (tests, scenario switches). */
  close(): void;
}

export function createMockBridge(scenario: Scenario): MockBridge {
  const listeners = new Set<(event: DeskEvent) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const settings = new Map<string, unknown>();
  let chats = 0;

  const emit = (event: DeskEvent) => {
    for (const fn of listeners) fn(event);
  };
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  // The timeline starts when the bridge is created; each event waits `after` ms past the previous one.
  let at = 0;
  for (const { after, event } of scenario.events) {
    at += after;
    later(at, () => emit(event));
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async request<T>(path: string) {
      if (!(path in scenario.data))
        throw new Error(`No mock data for ${path} in scenario "${scenario.name}"`);
      return structuredClone(scenario.data[path]) as T;
    },
    async chat(text, channel = "desk-typed"): Promise<ChatResponse> {
      const messageId = `mock-${++chats}`;
      const reply = scenario.chatReply ?? `(preview) You said: “${text}”. The real JARVIS answers here.`;
      const words = reply.split(/(?<= )/);
      later(0, () => {
        emit({ type: "brain.start", messageId, channel, text });
        emit({ type: "orb.state", state: "thinking" });
      });
      words.forEach((w, i) =>
        later(WORD_MS * (i + 1), () => emit({ type: "brain.delta", messageId, text: w })),
      );
      later(WORD_MS * (words.length + 1), () => {
        emit({
          type: "brain.done",
          messageId,
          text: reply,
          metrics: {
            ms: WORD_MS * words.length,
            model: "mock",
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: words.length,
            turns: 1,
          },
        });
        emit({ type: "orb.state", state: "idle" });
      });
      return { messageId };
    },
    openWindow(id) {
      const url = new URL(window.location.href);
      url.searchParams.set("window", id);
      window.open(url.toString(), `desk-${id}`);
    },
    settings: {
      get: async <T>(key: string) => settings.get(key) as T | undefined,
      set: async (key, value) => void settings.set(key, value),
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      listeners.clear();
    },
  };
}

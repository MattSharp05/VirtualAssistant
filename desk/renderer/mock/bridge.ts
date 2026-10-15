// window.desk in the browser: answers requests from the scenario's data, replays its events with
// their timings (routes answer writes), and streams a canned chat reply as brain.* events (like the real server does).
import { PROTOCOL_VERSION, type ChatResponse, type DeskBridge, type DeskEvent } from "@jarvis/shared";
import { createMockMac, type MockMacLog } from "./mac";
import type { Scenario } from "./types";

const WORD_MS = 60;

/** Scenario data that never answers: the request stays pending (loading states). */
export const PENDING = Symbol("pending");

export interface MockBridge extends DeskBridge {
  /** Stops pending timers (tests, scenario switches). */
  close(): void;
  /** Events and chat chunks still waiting to be replayed (e2e waits for 0). */
  pending(): number;
  /** What the overlay last reported (click-through off while true) and how often the orb was clicked. */
  readonly interactive: boolean;
  readonly orbClicks: number;
  /** Windows asked for with openWindow, and the frame buttons pressed ("minimize" | "close"), in order. */
  readonly opened: string[];
  readonly frameActions: string[];
  /** Every request(path, body), in order (e2e checks POSTs reached the "server"). */
  readonly requests: { path: string; body?: unknown }[];
  /** The Mac side (Settings): samples spoken. */
  readonly mac: NonNullable<DeskBridge["mac"]> & MockMacLog;
}

export function createMockBridge(scenario: Scenario): MockBridge {
  const listeners = new Set<(event: DeskEvent) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const settings = new Map<string, unknown>(Object.entries(scenario.settings ?? {}));
  // Each bridge has its own copy, so routes can change it (functions are kept as they are).
  const data = Object.fromEntries(
    Object.entries(scenario.data).map(([k, v]) => [
      k,
      typeof v === "function" || v === PENDING ? v : structuredClone(v),
    ]),
  );
  let chats = 0;
  let interactive = false;
  let orbClicks = 0;
  const opened: string[] = [];
  const frameActions: string[] = [];
  const requests: { path: string; body?: unknown }[] = [];

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
    async request<T>(path: string, body?: unknown) {
      requests.push(body === undefined ? { path } : { path, body });
      // A route's events arrive just after its answer, like the server's live stream.
      const ctx = { data, emit: (event: DeskEvent) => later(0, () => emit(event)) };
      for (const route of scenario.routes ?? []) {
        const answer = route(path, body, ctx);
        if (answer !== undefined) return structuredClone(answer) as T;
      }
      // An exact key first ("/calendar?start=…"), then the route without its query ("/calendar").
      const key = path in data ? path : path.split("?")[0]!;
      if (!(key in data)) throw new Error(`No mock data for ${path} in scenario "${scenario.name}"`);
      const entry = data[key];
      if (entry === PENDING) return new Promise<T>(() => {});
      // A function answers from the request body (POSTs whose answer echoes what was sent).
      return structuredClone(typeof entry === "function" ? entry(body) : entry) as T;
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
    openWindow(id, params) {
      opened.push(id);
      // An id may carry options for the window, e.g. "today?section=inbox" → ?window=today&section=inbox.
      const [windowId, query = ""] = id.split("?");
      const url = new URL(window.location.href);
      url.searchParams.set("window", windowId);
      for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
      for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
      window.open(url.toString(), `desk-${id}`);
    },
    settings: {
      get: async <T>(key: string) => settings.get(key) as T | undefined,
      set: async (key, value) => void settings.set(key, value),
    },
    pending: () => timers.size,
    get interactive() {
      return interactive;
    },
    get orbClicks() {
      return orbClicks;
    },
    opened,
    frameActions,
    requests,
    mac: createMockMac(scenario, settings),
    overlay: {
      setInteractive: (on) => void (interactive = on),
      orbClicked: () => void orbClicks++,
    },
    frame: {
      minimize: () => void frameActions.push("minimize"),
      close: () => void frameActions.push("close"),
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      listeners.clear();
    },
  };
}

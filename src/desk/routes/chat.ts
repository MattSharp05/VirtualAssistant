// The chat window's routes (the same conversation as Telegram and the dashboard):
//   POST /api/desk/chat { text, channel, model? } → { messageId }. The reply streams over /api/desk/events as
//        brain.start / brain.delta / brain.tool / brain.done (or brain.error) with that messageId.
//   GET  /api/desk/chat/history?before=<ISO>&limit=50 → a page of the current conversation, model, today's totals
//   POST /api/desk/chat/model { model } → { model }
//   POST /api/desk/chat/reset {}        → { ok }   (a new conversation, like Telegram's /newchat)
//   POST /api/desk/chat/warm { model? } → { started } (JD-48: the Desk, as Matthew starts talking, so the
//        warm brain process is up by the time he's done; started = it had to be started)
import { randomUUID } from "node:crypto";
import type { ChatHistoryResponse, ChatMessage, ChatModelResponse, ChatRequest, ChatResponse, ChatTotals } from "@jarvis/shared";
import type { Brain } from "../../brain/index.js";
import { briefFor } from "../../brief.js";
import type { BrainState } from "../../store.js";
import { UploadStore } from "../../uploads.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

const CHANNELS: ChatRequest["channel"][] = ["desk-voice", "desk-typed"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function brainOf(ctx: DeskContext): Brain {
  if (!ctx.brain) throw new DeskHttpError(503, "the brain isn't running");
  return ctx.brain;
}

/** A turn's own model (JD-48's voiceModel): one the brain offers, or undefined for the chosen one. */
function modelOf(brain: Brain, model: unknown): string | undefined {
  if (model === undefined || model === "") return undefined;
  if (typeof model !== "string" || !brain.models.includes(model)) throw new DeskHttpError(400, `Unknown model ${String(model)}. Choose one of: ${brain.models.join(", ")}`);
  return model;
}

/** "2026-10-14" for `at` in `timeZone`. */
const dayOf = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);

/** One page of the current conversation (oldest first) and today's totals, from the brain's message store. */
export function chatHistory(
  state: BrainState,
  opts: { before?: string; limit?: number; now?: Date; timeZone?: string } = {},
): Pick<ChatHistoryResponse, "messages" | "hasMore" | "today"> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT), MAX_LIMIT);
  const since = state.conversationStartedAt ?? "";
  const conversation = state.messages.filter((m) => m.at > since && (!opts.before || m.at < opts.before));
  const page = conversation.slice(-limit);
  const timeZone = opts.timeZone ?? (process.env.TZ || "UTC");
  const today = dayOf(opts.now ?? new Date(), timeZone);
  const totals: ChatTotals = { replies: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
  for (const { metrics: m, at } of state.messages) {
    if (!m || dayOf(new Date(at), timeZone) !== today) continue;
    totals.replies++;
    totals.inputTokens += m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    totals.outputTokens += m.outputTokens;
    totals.ms += m.ms;
  }
  const messages: ChatMessage[] = page.map(({ at, from, channel, text, metrics, steps }) => ({
    at,
    from,
    channel,
    text,
    ...(metrics ? { metrics } : {}),
    ...(steps?.length ? { steps } : {}),
  }));
  return { messages, hasMore: conversation.length > page.length, today: totals };
}

const routes: DeskRoute[] = [
  {
    method: "POST",
    path: "/chat",
    handler: ({ body, ctx }): ChatResponse => {
      const brain = brainOf(ctx);
      const text = String(body.text ?? "").trim();
      if (!text) throw new DeskHttpError(400, "text is empty");
      const channel = CHANNELS.find((c) => c === body.channel) ?? "desk-typed";
      const model = modelOf(brain, body.model);
      const ids = Array.isArray(body.attachments) ? body.attachments : [];
      const store = ids.length ? new UploadStore(ctx.jarvis.config.dataDir) : undefined;
      const attachments = ids.map((id) => {
        const upload = store!.get(String(id));
        if (!upload) throw new DeskHttpError(400, `No upload ${String(id)} (they're kept for 7 days).`);
        return upload;
      });
      // The first Desk voice turn of the morning gets the brief first (JD-23), then this request.
      const brief = channel === "desk-voice" ? briefFor(ctx.jarvis) : undefined;
      if (brief?.claimFirstTurn()) {
        const run = brief.start(channel);
        run.done.catch((err: Error) => console.warn("morning brief:", err.message));
        const messageId = randomUUID();
        void run.queued.then(() => brain.start(text, channel, { attachments, messageId, model }).done.catch(() => undefined));
        return { messageId };
      }
      const { messageId, done } = brain.start(text, channel, { attachments, model });
      // Failures reach the Desk as brain.error on the stream.
      done.catch(() => undefined);
      return { messageId };
    },
  },
  {
    method: "GET",
    path: "/chat/history",
    handler: ({ url, ctx }): ChatHistoryResponse => {
      const brain = brainOf(ctx);
      const before = url.searchParams.get("before") || undefined;
      if (before && Number.isNaN(Date.parse(before))) throw new DeskHttpError(400, "before must be an ISO date-time");
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const page = chatHistory(ctx.jarvis.store.brain(), { before, limit });
      return { ...page, model: brain.model, models: brain.models };
    },
  },
  {
    method: "POST",
    path: "/chat/model",
    handler: ({ body, ctx }): ChatModelResponse => {
      const brain = brainOf(ctx);
      try {
        brain.setModel(String(body.model ?? ""));
      } catch (err) {
        throw new DeskHttpError(400, (err as Error).message);
      }
      return { model: brain.model };
    },
  },
  {
    method: "POST",
    path: "/chat/warm",
    handler: async ({ body, ctx }) => {
      const brain = brainOf(ctx);
      return { started: await brain.prewarm(modelOf(brain, body.model)) };
    },
  },
  {
    method: "POST",
    path: "/chat/reset",
    handler: ({ ctx }) => {
      brainOf(ctx).reset();
      return { ok: true };
    },
  },
];

export default routes;

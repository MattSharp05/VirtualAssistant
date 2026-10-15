// POST /api/desk/chat { text, channel } → { messageId }. The reply streams over /api/desk/events as
// brain.start / brain.delta / brain.tool / brain.done (or brain.error) with that messageId.
import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse } from "@jarvis/shared";
import { briefFor } from "../../brief.js";
import { UploadStore } from "../../uploads.js";
import { DeskHttpError, type DeskRoute } from "./index.js";

const CHANNELS: ChatRequest["channel"][] = ["desk-voice", "desk-typed"];

const route: DeskRoute = {
  method: "POST",
  path: "/chat",
  handler: ({ body, ctx }): ChatResponse => {
    if (!ctx.brain) throw new DeskHttpError(503, "the brain isn't running");
    const text = String(body.text ?? "").trim();
    if (!text) throw new DeskHttpError(400, "text is empty");
    const channel = CHANNELS.find((c) => c === body.channel) ?? "desk-typed";
    const ids = Array.isArray(body.attachments) ? body.attachments : [];
    const store = ids.length ? new UploadStore(ctx.jarvis.config.dataDir) : undefined;
    const attachments = ids.map((id) => {
      const upload = store!.get(String(id));
      if (!upload) throw new DeskHttpError(400, `No upload ${String(id)} (they're kept for 7 days).`);
      return upload;
    });
    const brain = ctx.brain;
    // The first Desk voice turn of the morning gets the brief first (JD-23), then this request.
    const brief = channel === "desk-voice" ? briefFor(ctx.jarvis) : undefined;
    if (brief?.claimFirstTurn()) {
      const run = brief.start(channel);
      run.done.catch((err: Error) => console.warn("morning brief:", err.message));
      const messageId = randomUUID();
      void run.queued.then(() => brain.start(text, channel, { attachments, messageId }).done.catch(() => undefined));
      return { messageId };
    }
    const { messageId, done } = brain.start(text, channel, { attachments });
    // Failures reach the Desk as brain.error on the stream.
    done.catch(() => undefined);
    return { messageId };
  },
};

export default route;

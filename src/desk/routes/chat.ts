// POST /api/desk/chat { text, channel } → { messageId }. The reply streams over /api/desk/events as
// brain.start / brain.delta / brain.tool / brain.done (or brain.error) with that messageId.
import type { ChatRequest, ChatResponse } from "@jarvis/shared";
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
    const { messageId, done } = ctx.brain.start(text, channel, { attachments });
    // Failures reach the Desk as brain.error on the stream.
    done.catch(() => undefined);
    return { messageId };
  },
};

export default route;

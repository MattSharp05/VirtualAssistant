// The morning brief on demand (the Today window's Play button, "morning brief" by voice):
//   POST /api/desk/brief { channel? } → { messageId }. The brief streams over /api/desk/events as
//   brain.* events with that messageId, then brief.ready with the text.
import type { BriefResponse, ChatRequest } from "@jarvis/shared";
import { briefFor } from "../../brief.js";
import { DeskHttpError, type DeskRoute } from "./index.js";

const CHANNELS: ChatRequest["channel"][] = ["desk-voice", "desk-typed"];

const route: DeskRoute = {
  method: "POST",
  path: "/brief",
  handler: ({ body, ctx }): BriefResponse => {
    const brief = briefFor(ctx.jarvis);
    if (!brief) throw new DeskHttpError(503, "the brain isn't running");
    const channel = CHANNELS.find((c) => c === body.channel) ?? "desk-voice";
    const { messageId, done } = brief.start(channel);
    // Failures reach the Desk as brain.error on the stream (or are logged if gathering failed).
    done.catch((err: Error) => console.warn("morning brief:", err.message));
    return { messageId };
  },
};

export default route;

// Screen awareness and clipboard help (JD-44): look_at_screen and get_clipboard ask the connected Desk
// (rpc "screen.capture" / "clipboard.read", src/desk/rpc.ts). The Desk captures the display under the
// pointer with the overlay hidden, or reads the clipboard, uploads any image through POST
// /api/desk/files and answers with the upload; the brain then Reads that path like an attachment. Only
// when Matthew asks: the hint says so, and the Desk shows a card each time it looks.
import { CLIPBOARD_MAX_CHARS, CLIPBOARD_RPC, SCREEN_RPC, type ClipboardReadResult, type ScreenCaptureResult, type UploadResponse } from "@jarvis/shared";
import { JarvisError } from "../jarvis.js";
import { UploadStore } from "../uploads.js";
import { schema, type ToolContext, type ToolGroup } from "./types.js";

export const NOT_CONNECTED = "Your Mac isn't connected (JARVIS Desk isn't running), so I can't see its screen or clipboard right now.";

async function deskRpc(ctx: ToolContext, kind: string): Promise<unknown> {
  const desk = ctx.desk;
  if (!desk || desk.hub.clientCount === 0) throw new JarvisError(NOT_CONNECTED);
  return desk.rpc.call(kind, {});
}

/** The upload the Desk names, looked up here by id: only files in the uploads folder are Read. */
function uploadPath(ctx: ToolContext, upload: UploadResponse | undefined): string {
  const found = typeof upload?.id === "string" ? new UploadStore(ctx.config.dataDir).get(upload.id) : undefined;
  if (!found) throw new JarvisError("The Mac's upload didn't arrive; try again.");
  return found.path;
}

const group: ToolGroup = {
  name: "screen",
  promptHint:
    "- Matthew's screen and clipboard: use look_at_screen or get_clipboard ONLY when he explicitly asks about what's on his screen or his clipboard (\"what am I looking at?\", \"tidy up my clipboard\"); never on your own, to check context or out of curiosity. look_at_screen gives a screenshot path, then Read it. You can't write to the clipboard: give the improved text in your reply.",
  tools: [
    {
      name: "look_at_screen",
      description:
        "Take one screenshot of the display under Matthew's pointer on his Mac (JARVIS's own orb hidden) and return a path to Read it from. Only when he asks about his screen.",
      inputSchema: schema({}),
      handler: async (_a, ctx) => {
        const out = (await deskRpc(ctx, SCREEN_RPC)) as ScreenCaptureResult;
        const size = out?.width && out?.height ? ` (${out.width}×${out.height})` : "";
        return `Took a screenshot of Matthew's screen${size}. Read ${uploadPath(ctx, out?.upload)} to see it.`;
      },
    },
    {
      name: "get_clipboard",
      description: `Read what's on Matthew's Mac clipboard: text (up to ${CLIPBOARD_MAX_CHARS.toLocaleString("en")} characters) or an image (as a path to Read). Only when he asks about his clipboard.`,
      inputSchema: schema({}),
      handler: async (_a, ctx) => {
        const out = (await deskRpc(ctx, CLIPBOARD_RPC)) as ClipboardReadResult;
        if (out?.kind === "image") return `The clipboard holds an image. Read ${uploadPath(ctx, out.upload)} to see it.`;
        if (out?.kind !== "text" || !out.text.trim()) return "The clipboard is empty (or holds something that isn't text or an image).";
        const text = out.text.slice(0, CLIPBOARD_MAX_CHARS);
        const cut = out.truncated || out.text.length > CLIPBOARD_MAX_CHARS ? `\n\n(Only the first ${CLIPBOARD_MAX_CHARS.toLocaleString("en")} characters are shown.)` : "";
        return `The clipboard holds this text:\n\n${text}${cut}`;
      },
    },
  ],
};

export default group;

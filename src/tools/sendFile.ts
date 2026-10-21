// "Send it to my phone": JARVIS pushes an upload (a screenshot from look_at_screen, a clipboard image,
// a file Matthew handed it) to his Telegram chat as a photo or a document (JD-78). With no Telegram
// bot or chat configured it says so, and JARVIS answers in text instead.
import { JarvisError } from "../jarvis.js";
import { notifier } from "../notify.js";
import { UploadStore } from "../uploads.js";
import { schema, str, type ToolGroup } from "./types.js";

export const NO_TELEGRAM = "Telegram isn't connected, so I can't send files there.";

const group: ToolGroup = {
  name: "send",
  promptHint:
    "- When Matthew asks to have a file or picture sent to his phone or Telegram (e.g. a screenshot from look_at_screen or an image from get_clipboard he wants to see, not just hear described), use send_file with its upload id (the 12-hex folder in its uploads path, …/uploads/<id>/<name>). Only when he asks for it; never send files unprompted.",
  tools: [
    {
      name: "send_file",
      description:
        "Send an uploaded file (screenshot, clipboard image, or any file in the uploads store) to Matthew's Telegram chat: images as a photo, other files as a document.",
      inputSchema: schema(
        {
          uploadId: str("The upload's id (12 hex characters, the folder name in …/uploads/<id>/<name>, e.g. from look_at_screen or get_clipboard)"),
          caption: str("Optional short caption shown under the file"),
        },
        ["uploadId"],
      ),
      handler: async (a, ctx) => {
        const upload = new UploadStore(ctx.config.dataDir).get(String(a.uploadId ?? ""));
        if (!upload) throw new JarvisError(`No upload with id ${String(a.uploadId ?? "")}; it may have expired (uploads are kept 7 days).`);
        if (!notifier.canSendFiles) return NO_TELEGRAM;
        const caption = typeof a.caption === "string" && a.caption.trim() ? a.caption : undefined;
        try {
          if (!(await notifier.sendTelegramFile(upload, caption))) return NO_TELEGRAM;
        } catch (err) {
          throw new JarvisError(`Telegram didn't take ${upload.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return `Sent ${upload.name} to Telegram.`;
      },
    },
  ],
};

export default group;

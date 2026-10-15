// Clipboard help (JD-44): the server's get_clipboard tool arrives here as the rpc "clipboard.read".
// Text comes back as is (cut at 20k characters); an image is uploaded like a dropped file and answered
// with the upload. Read-only: JARVIS never writes the clipboard. Each read puts a brief card beside the
// orb, like a look at the screen. No Electron in here: the clipboard comes in as two functions.
import {
  CLIPBOARD_MAX_CHARS,
  type ClipboardReadResult,
  type DeskEvent,
  type ScreenCard,
  type UploadResponse,
} from "@jarvis/shared";
import type { UploadSource } from "../uploads";
import { LOOK_CARD_MS } from "./screen";

export const CLIPBOARD_CARD_ID = "clipboard-read";

export interface ClipboardDeps {
  readText(): Promise<string>;
  /** The clipboard's image as PNG; undefined when it holds none. */
  readImage(): Promise<Uint8Array | undefined>;
  upload(source: UploadSource): Promise<UploadResponse>;
  publish(event: DeskEvent): void;
  now?(): Date;
  later?(fn: () => void, ms: number): void;
}

export function clipboardCard(at: Date, what: "text" | "image"): ScreenCard {
  return {
    id: CLIPBOARD_CARD_ID,
    createdAt: at.toISOString(),
    title: "📋 Read your clipboard",
    body:
      what === "image"
        ? "The image you copied, because you asked."
        : "The text you copied, because you asked.",
    kind: "text",
  };
}

export class ClipboardReader {
  constructor(private readonly deps: ClipboardDeps) {}

  async read(): Promise<ClipboardReadResult> {
    const { deps } = this;
    // Text first: copying from a page can put both text and a picture of it on the clipboard.
    const text = await deps.readText();
    const image = text.trim() ? undefined : await deps.readImage();
    if (!text.trim() && !image?.length) return { kind: "empty" };
    const at = (deps.now ?? (() => new Date()))();
    deps.publish({ type: "card.show", card: clipboardCard(at, image ? "image" : "text") });
    (deps.later ?? setTimeout)(
      () => deps.publish({ type: "card.dismiss", id: CLIPBOARD_CARD_ID }),
      LOOK_CARD_MS,
    );
    if (image) return { kind: "image", upload: await deps.upload({ name: "clipboard.png", bytes: image }) };
    return {
      kind: "text",
      text: text.slice(0, CLIPBOARD_MAX_CHARS),
      truncated: text.length > CLIPBOARD_MAX_CHARS,
    };
  }
}

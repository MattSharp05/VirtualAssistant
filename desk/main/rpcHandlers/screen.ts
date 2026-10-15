// Screen awareness (JD-44): the server's look_at_screen tool arrives here as the rpc "screen.capture".
// Only when Matthew asks (the brain's hint says so); each look puts a brief "📸 Looked at your screen"
// card beside the orb. The display under the pointer is captured with the overlay hidden (so the orb
// and its cards aren't in the shot), uploaded like a dropped file (uploads.ts) and answered with the
// upload. No Electron in here: capture, overlay, upload and cards come in as small functions.
import type { DeskEvent, ScreenCaptureResult, ScreenCard, UploadResponse } from "@jarvis/shared";
import type { UploadSource } from "../uploads";

export const SCREEN_CARD_ID = "screen-look";
/** How long the card stays: long enough to notice, short enough not to clutter. */
export const LOOK_CARD_MS = 6_000;
/** Longest side of the screenshot in pixels: sharp enough to read text, small enough to upload fast. */
export const MAX_SHOT_SIDE = 2560;
/** The overlay's last frame can linger on screen for a moment after it's hidden. */
export const HIDE_SETTLE_MS = 120;

export const SCREEN_RECORDING_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface Display {
  id: number;
  /** In points. */
  size: { width: number; height: number };
  scaleFactor: number;
}

export type ScreenAccess = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export interface ScreenDeps {
  /** The display the pointer is on. */
  pointerDisplay(): Display;
  /** macOS Screen Recording permission (the first capture asks when it's "not-determined"). */
  access(): ScreenAccess;
  /** Hides the overlay; resolves to a function that puts it back as it was. */
  hideOverlay(): Promise<() => void>;
  /** A JPEG of the display at this pixel size; undefined when macOS gave no picture. */
  capture(display: Display, size: { width: number; height: number }): Promise<Uint8Array | undefined>;
  upload(source: UploadSource): Promise<UploadResponse>;
  publish(event: DeskEvent): void;
  now?(): Date;
  wait?(ms: number): Promise<void>;
  later?(fn: () => void, ms: number): void;
}

/** The screenshot's pixel size: the display's real pixels, scaled down so the longest side fits. */
export function shotSize(display: Display, max = MAX_SHOT_SIDE): { width: number; height: number } {
  const width = display.size.width * display.scaleFactor;
  const height = display.size.height * display.scaleFactor;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** "screen-2026-10-15-091200.jpg" */
export function shotName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `screen-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.jpg`;
}

/** The transparency card: every look shows it. */
export function lookCard(at: Date): ScreenCard {
  return {
    id: SCREEN_CARD_ID,
    createdAt: at.toISOString(),
    title: "📸 Looked at your screen",
    body: "One screenshot of this display, because you asked.",
    kind: "text",
  };
}

export class ScreenRefused extends Error {}

export class ScreenLook {
  constructor(private readonly deps: ScreenDeps) {}

  async capture(): Promise<ScreenCaptureResult> {
    const { deps } = this;
    const access = deps.access();
    if (access === "denied" || access === "restricted")
      throw new ScreenRefused(
        "macOS hasn't allowed JARVIS Desk to record the screen. Matthew can turn it on in System Settings → Privacy & Security → Screen Recording.",
      );
    const display = deps.pointerDisplay();
    const restore = await deps.hideOverlay();
    let jpeg: Uint8Array | undefined;
    try {
      await (deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(HIDE_SETTLE_MS);
      jpeg = await deps.capture(display, shotSize(display));
    } finally {
      restore();
    }
    if (!jpeg?.length)
      throw new ScreenRefused(
        "The screenshot came back empty. If macOS just asked about Screen Recording, Matthew needs to allow JARVIS Desk and try again.",
      );
    const at = (deps.now ?? (() => new Date()))();
    deps.publish({ type: "card.show", card: lookCard(at) });
    (deps.later ?? setTimeout)(
      () => deps.publish({ type: "card.dismiss", id: SCREEN_CARD_ID }),
      LOOK_CARD_MS,
    );
    const upload = await deps.upload({ name: shotName(at), bytes: jpeg });
    return { upload, width: display.size.width, height: display.size.height };
  }
}

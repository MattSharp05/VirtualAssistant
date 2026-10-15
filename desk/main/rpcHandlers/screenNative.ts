// The Electron side of screen awareness and clipboard help (JD-44): desktopCapturer, the clipboard and
// the overlay window wired into ScreenLook and ClipboardReader (their logic and tests are next to this).
// The first capture makes macOS ask for Screen Recording.
import { CLIPBOARD_RPC, SCREEN_RPC, type DeskEvent, type UploadResponse } from "@jarvis/shared";
import { clipboard, desktopCapturer, screen, systemPreferences, type BrowserWindow } from "electron";
import type { UploadSource } from "../uploads";
import { ClipboardReader } from "./clipboard";
import type { RpcHandler } from "./index";
import { ScreenLook, type ScreenAccess } from "./screen";

export interface ScreenNativeDeps {
  /** The overlay with the orb and its cards, hidden for the shot. */
  overlay(): BrowserWindow | undefined;
  upload(source: UploadSource): Promise<UploadResponse>;
  publish(event: DeskEvent): void;
}

export function screenRpcHandlers(deps: ScreenNativeDeps): Record<string, RpcHandler> {
  const look = new ScreenLook({
    pointerDisplay: () => {
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      return { id: d.id, size: d.size, scaleFactor: d.scaleFactor };
    },
    access: () =>
      process.platform === "darwin"
        ? (systemPreferences.getMediaAccessStatus("screen") as ScreenAccess)
        : "granted",
    hideOverlay: async () => {
      const win = deps.overlay();
      const shown = !!win && !win.isDestroyed() && win.isVisible();
      if (shown) win.hide();
      return () => {
        if (shown && !win.isDestroyed()) win.showInactive();
      };
    },
    capture: async (display, size) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      return source && !source.thumbnail.isEmpty() ? new Uint8Array(source.thumbnail.toJPEG(85)) : undefined;
    },
    upload: deps.upload,
    publish: deps.publish,
  });
  const reader = new ClipboardReader({
    readText: () => clipboard.readText(),
    readImage: async () => {
      for (const item of await clipboard.read()) {
        if (!item.types.includes("image/png")) continue;
        const blob = await item.getType("image/png");
        if (blob instanceof Blob) return new Uint8Array(await blob.arrayBuffer());
      }
      return undefined;
    },
    upload: deps.upload,
    publish: deps.publish,
  });
  return {
    [SCREEN_RPC]: () => look.capture(),
    [CLIPBOARD_RPC]: () => reader.read(),
  };
}

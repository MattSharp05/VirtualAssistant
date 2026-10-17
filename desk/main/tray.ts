// The menu-bar icon and its menu (mockup 8). The menu itself is plain data (trayMenu.ts); this file
// turns it into Electron's Menu and rebuilds it when settings, the connection or plan usage change.
// JD-62: the Tray lives in a module-level reference (a Tray that's garbage-collected vanishes from the
// menu bar), is made only after app ready, and its glyph is a PNG template image with 1× and 2×
// representations (18 pt); an empty image is logged instead of silently showing nothing.
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { DeskConnection } from "@jarvis/shared";
import { encodePng, orbGlyph, statusDot, type Bitmap } from "./trayIcons";
import { trayMenu, type TrayActions, type TrayItem, type TrayState } from "./trayMenu";

/** A drawing at 1× and 2× as one nativeImage (macOS picks the representation for the screen). */
const image = (draw: (scale: 1 | 2) => Bitmap) => {
  const img = nativeImage.createFromBuffer(encodePng(draw(1)), { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: encodePng(draw(2)) });
  return img;
};

const dots = new Map<DeskConnection["state"], Electron.NativeImage>();
const dotImage = (state: DeskConnection["state"]) => {
  if (!dots.has(state))
    dots.set(
      state,
      image((scale) => statusDot(state, scale)),
    );
  return dots.get(state)!;
};

function toElectron({ dot, ...item }: TrayItem): MenuItemConstructorOptions {
  return dot ? { ...item, icon: dotImage(dot) } : item;
}

export interface DeskTray {
  /** Rebuilds the menu from the current state. */
  refresh(): void;
  destroy(): void;
}

/** What the Electron smoke test checks (JD-62): the tray is there with a real template image. */
export interface TrayCheck {
  exists: boolean;
  empty: boolean;
  template: boolean;
  size: { width: number; height: number };
}

// Long-lived on purpose: a Tray only referenced from a closure can be collected and disappear.
let tray: Tray | undefined;
let trayIcon: Electron.NativeImage | undefined;

export function trayCheck(): TrayCheck {
  return {
    exists: Boolean(tray && !tray.isDestroyed()),
    empty: trayIcon?.isEmpty() ?? true,
    template: trayIcon?.isTemplateImage() ?? false,
    size: trayIcon?.getSize() ?? { width: 0, height: 0 },
  };
}

/** Call after app ready. */
export function createTray(state: () => TrayState, actions: TrayActions): DeskTray {
  trayIcon = image((scale) => orbGlyph(scale));
  trayIcon.setTemplateImage(true);
  if (trayIcon.isEmpty()) console.error("tray: the menu-bar image is empty; the icon won't show");
  const own = new Tray(trayIcon);
  tray = own;
  own.setToolTip("JARVIS Desk");
  const refresh = () => {
    if (own.isDestroyed()) return;
    own.setContextMenu(Menu.buildFromTemplate(trayMenu(state(), actions).map(toElectron)));
  };
  refresh();
  return {
    refresh,
    destroy: () => {
      own.destroy();
      if (tray === own) tray = undefined;
    },
  };
}

// The menu-bar icon and its menu (mockup 8). The menu itself is plain data (trayMenu.ts); this file
// turns it into Electron's Menu and rebuilds it when settings, the connection or plan usage change.
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { DeskConnection } from "@jarvis/shared";
import { orbGlyph, statusDot, type Bitmap } from "./trayIcons";
import { trayMenu, type TrayActions, type TrayItem, type TrayState } from "./trayMenu";

/** A @2x bitmap as a nativeImage of half its pixel size. */
const image = (bmp: Bitmap) =>
  nativeImage.createFromBitmap(bmp.data, { width: bmp.width, height: bmp.height, scaleFactor: 2 });

const dots = new Map<DeskConnection["state"], Electron.NativeImage>();
const dotImage = (state: DeskConnection["state"]) => {
  if (!dots.has(state)) dots.set(state, image(statusDot(state, 2)));
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

export function createTray(state: () => TrayState, actions: TrayActions): DeskTray {
  const icon = image(orbGlyph(2));
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip("JARVIS Desk");
  const refresh = () => {
    if (tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate(trayMenu(state(), actions).map(toElectron)));
  };
  refresh();
  return { refresh, destroy: () => tray.destroy() };
}

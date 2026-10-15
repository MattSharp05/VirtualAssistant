// Camera hands on Desk windows (JD-47): the overlay's bridge.hands calls (preload/index.ts). Points and
// bounds arrive in the asking window's coordinates; handWindows.ts does the maths.
import { BrowserWindow, ipcMain } from "electron";
import { isRect, screenBounds, windowAt } from "./handWindows";
import type { WindowManager } from "./manager";

export function registerHandWindows(windows: WindowManager): void {
  const origin = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const b = BrowserWindow.fromWebContents(e.sender)?.getBounds();
    return { x: b?.x ?? 0, y: b?.y ?? 0 };
  };
  ipcMain.handle("desk:hands-window-at", (e, point: { x: number; y: number }, part: string) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
    return windowAt(windows.stack(), point, part === "any" ? "any" : "titlebar", origin(e));
  });
  ipcMain.on("desk:hands-set-bounds", (e, id: string, rect: unknown, done?: boolean) => {
    if (typeof id !== "string" || !isRect(rect)) return;
    windows.setBounds(id, screenBounds(rect, origin(e), windows.minSize(id)), done === true);
  });
  ipcMain.on("desk:hands-minimize", (_e, id: string) => typeof id === "string" && windows.minimize(id));
}

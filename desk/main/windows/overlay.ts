// The overlay (PRD: overlay + orb; ADR 0001): one transparent, frameless, always-on-top window over
// the primary display's work area, on every Space and over full-screen apps. Clicks pass through to
// the apps underneath, except while the renderer reports the pointer over the orb (desk:hit).
import { join } from "node:path";
import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { DROP_POLL_MS, inside, orbZone, OverlayMouse } from "./dropZone";
import { isExternalLink } from "./target";

export function createOverlay(
  rendererIndex: string,
  scenario?: string,
  /** Links main handles itself (the updater's Update button, JD-46): true when it took the link. */
  handleLink?: (url: string) => boolean,
): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...workArea,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    title: "JARVIS Desk",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through by default; `forward` keeps mouse-move events coming so hover can be detected.
  win.setIgnoreMouseEvents(true, { forward: true });

  const mouse = new OverlayMouse((on) => {
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
  });
  const onHit = (e: Electron.IpcMainEvent, interactive: boolean) => {
    if (e.sender === win.webContents) mouse.setHit(interactive);
  };
  ipcMain.on("desk:hit", onHit);
  // File drop (JD-40): the orb's spot takes the mouse while the pointer is on it, so a drag reaches it.
  const watch = setInterval(
    () => mouse.setNear(inside(screen.getCursorScreenPoint(), orbZone(win.getBounds()))),
    DROP_POLL_MS,
  );
  win.on("closed", () => clearInterval(watch));
  // Links on cards (JD-27) open in the default browser, never in a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (handleLink?.(url)) return { action: "deny" };
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => ipcMain.off("desk:hit", onHit));

  // Follow the display if its size or the Dock/menu bar changes.
  screen.on("display-metrics-changed", () => {
    if (!win.isDestroyed()) win.setBounds(screen.getPrimaryDisplay().workArea);
  });

  void win.loadFile(rendererIndex, { hash: "/overlay", ...(scenario ? { query: { scenario } } : {}) });
  return win;
}

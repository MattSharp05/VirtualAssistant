// JARVIS Desk main process: an agent app (no Dock icon, LSUIElement) whose UI is the overlay with
// the orb (windows/overlay.ts) and the feature windows it opens (windows/manager.ts). Tray and voice
// arrive in later tickets (docs/TDD.md).
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { Settings } from "./settings";
import { WindowManager } from "./windows/manager";
import { createOverlay } from "./windows/overlay";

app.whenReady().then(() => {
  app.dock?.hide();
  // No visible menu bar for an agent app, but ⌘Q still quits while JARVIS is focused (tray: JD-26).
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "JARVIS Desk", submenu: [{ role: "quit" }] }]));

  const settings = new Settings(join(app.getPath("userData"), "settings.json"));
  app.on("before-quit", () => settings.flush());
  const rendererIndex = join(__dirname, "../renderer/dist/index.html");
  const scenario = process.env.JARVIS_DESK_SCENARIO;
  const windows = new WindowManager(rendererIndex, settings, scenario);

  // The bridge's main side (preload/index.ts). Talking to the server needs pairing (JD-26); until
  // then requests fail clearly.
  ipcMain.handle("desk:request", () => {
    throw new Error("Not connected to JARVIS yet: pair this Mac in Settings.");
  });
  ipcMain.handle("desk:settings-get", (_e, key: string) => settings.get(key));
  ipcMain.handle("desk:settings-set", (_e, key: string, value: unknown) => settings.set(key, value));
  ipcMain.on("desk:open-window", (_e, id: string, params?: Record<string, string>) =>
    windows.openWindow(id, params),
  );
  // A window's own frame buttons. Minimise hides it (an agent app has no Dock to minimise to); the
  // launcher brings it back where it was.
  ipcMain.on("desk:frame-minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.on("desk:frame-close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());

  const overlay = createOverlay(rendererIndex, scenario);
  // The launcher ring opens in the overlay; focus it so Esc reaches the ring.
  ipcMain.on("desk:orb-click", () => overlay.focus());
});
app.on("window-all-closed", () => app.quit());

// JARVIS Desk main process: an agent app (no Dock icon, LSUIElement) whose UI is the overlay with
// the orb (windows/overlay.ts). Windows, tray and voice arrive in later tickets (docs/TDD.md).
import { join } from "node:path";
import { app, ipcMain, Menu } from "electron";
import { createOverlay } from "./windows/overlay";

// The bridge's main side (preload/index.ts). Talking to the server needs pairing (JD-26); until
// then requests fail clearly and settings live in memory.
const settings = new Map<string, unknown>();
ipcMain.handle("desk:request", () => {
  throw new Error("Not connected to JARVIS yet: pair this Mac in Settings.");
});
ipcMain.handle("desk:settings-get", (_e, key: string) => settings.get(key));
ipcMain.handle("desk:settings-set", (_e, key: string, value: unknown) => void settings.set(key, value));
ipcMain.on("desk:open-window", (_e, id: string) =>
  console.log(`open window ${id}: the window manager arrives in JD-20`),
);
ipcMain.on("desk:orb-click", () => console.log("orb clicked: the launcher ring arrives in JD-20"));

app.whenReady().then(() => {
  app.dock?.hide();
  // No visible menu bar for an agent app, but ⌘Q still quits while JARVIS is focused (tray: JD-26).
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "JARVIS Desk", submenu: [{ role: "quit" }] }]));
  createOverlay(join(__dirname, "../renderer/dist/index.html"), process.env.JARVIS_DESK_SCENARIO);
});
app.on("window-all-closed", () => app.quit());

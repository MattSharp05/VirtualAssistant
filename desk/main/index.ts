// JARVIS Desk main process. For now it opens one placeholder window; the overlay, window
// manager, tray and voice arrive in later tickets (docs/TDD.md).
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: "JARVIS Desk",
    backgroundColor: "#11161C",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // Windows (JD-20) select what renders through the hash route; JARVIS_DESK_SCENARIO runs the mock bridge.
  const scenario = process.env.JARVIS_DESK_SCENARIO;
  void win.loadFile(join(__dirname, "../renderer/dist/index.html"), {
    hash: "/home",
    ...(scenario ? { query: { scenario } } : {}),
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

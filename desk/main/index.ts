// JARVIS Desk main process. For now it opens one placeholder window; the overlay, window
// manager, tray and voice arrive in later tickets (docs/TDD.md).
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: "JARVIS Desk",
    backgroundColor: "#11161C",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // Scenarios (JD-7) and windows (JD-20) select what renders through the hash route.
  void win.loadFile(join(__dirname, "../renderer/dist/index.html"), { hash: "/home" });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

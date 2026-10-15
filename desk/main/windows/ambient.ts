// The ambient face's window (JD-25, PRD: faces): borderless and full screen on a chosen display
// (default: a non-primary one if connected), opened when the Face setting is "ambient". Esc closes it;
// while it covers the primary display the corner orb hides. The logic is in ambientFace.ts.
import { join } from "node:path";
import { BrowserWindow, screen, type Display } from "electron";
import { AmbientFace, type FaceWindow } from "./ambientFace";

export function createAmbient(
  rendererIndex: string,
  overlay: BrowserWindow,
  onClosed: () => void,
  scenario?: string,
): AmbientFace<Display> {
  const face = new AmbientFace<Display>({
    displays: () => screen.getAllDisplays(),
    primaryId: () => screen.getPrimaryDisplay().id,
    createWindow: (display) => faceWindow(rendererIndex, display, scenario),
    cornerOrb: {
      hide: () => !overlay.isDestroyed() && overlay.hide(),
      show: () => !overlay.isDestroyed() && overlay.showInactive(),
    },
    onClosed,
  });
  screen.on("display-removed", (_e, display) => face.displayRemoved(display.id));
  return face;
}

function faceWindow(rendererIndex: string, display: Display, scenario?: string): FaceWindow {
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#080b0e",
    show: false,
    title: "JARVIS Ambient",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => {
    // Pre-Lion full screen: covers the whole display (menu bar included) without a new Space.
    win.setBounds(display.bounds);
    if (process.platform === "darwin") win.setSimpleFullScreen(true);
    win.show();
  });
  // Esc closes the face even if the page has lost focus of its own key handler.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape") return;
    event.preventDefault();
    win.close();
  });
  void win.loadFile(rendererIndex, { hash: "/ambient", ...(scenario ? { query: { scenario } } : {}) });
  return {
    close: () => !win.isDestroyed() && win.close(),
    focus: () => !win.isDestroyed() && win.focus(),
    onClosed: (fn) => win.on("closed", fn),
  };
}

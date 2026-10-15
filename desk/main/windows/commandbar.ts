// The command bar's window (JD-28): ⌘⇧Space (or the tray's "Command bar") toggles a small frameless,
// see-through window over whatever app is in front, on the display with the pointer. It closes on Esc
// (the renderer's frame.close), on ↵, and as soon as it loses focus; the next toggle makes a new one.
import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import commandbar from "../../renderer/features/commandbar/feature";
import { windowHash } from "../../renderer/app/router";
import { DEFAULT_SIZE } from "../../renderer/features/types";
import { commandBarBounds } from "./commandbarBounds";

export const COMMAND_BAR_SHORTCUT = "CommandOrControl+Shift+Space";

export class CommandBar {
  private win?: BrowserWindow;

  constructor(
    private readonly rendererIndex: string,
    private readonly scenario?: string,
  ) {}

  toggle(): void {
    if (this.win && !this.win.isDestroyed()) this.close();
    else this.open();
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = undefined;
  }

  /** Opens the bar (a fresh one), e.g. prefilled with params from the drop card's Ask (JD-40). */
  open(params?: Record<string, string>): void {
    this.close();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const win = new BrowserWindow({
      ...commandBarBounds(commandbar.defaultSize ?? DEFAULT_SIZE, display.workArea),
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#00000000",
      title: commandbar.title,
      webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    this.win = win;
    // Above full-screen apps and on whichever Space Matthew is in.
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.once("ready-to-show", () => {
      win.show();
      // An agent app isn't the active app: take focus so typing reaches the bar straight away.
      app.focus({ steal: true });
      win.focus();
    });
    win.on("blur", () => {
      if (this.win === win) this.close();
    });
    win.on("closed", () => {
      if (this.win === win) this.win = undefined;
    });
    void win.loadFile(this.rendererIndex, {
      hash: windowHash(commandbar.id, params),
      ...(this.scenario ? { query: { scenario: this.scenario } } : {}),
    });
  }
}

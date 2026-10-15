// Saved layouts in the running app (JD-37): the tray's Layout section, the command bar and "Jarvis,
// work mode" (the server's apply_layout tool sends a layout.apply rpc) all end up here. The window
// manager, settings and screen come in as small interfaces, so this is tested without Electron.
import { execFile } from "node:child_process";
import type { LayoutApplied, LayoutSummary, RpcAnswer } from "@jarvis/shared";
import type { Rect } from "../windows/bounds";
import {
  activeLayout,
  allLayouts,
  captureLayout,
  cleanName,
  findLayout,
  planLayout,
  type Display,
  type Size,
} from "../windows/layouts";

export interface LayoutDeps {
  windows: {
    openWindows(): { windowId: string; bounds: Rect }[];
    windowIds(): string[];
    placeWindow(id: string, bounds: Rect): void;
    closeWindow(id: string): void;
    minSize(id: string): Size;
  };
  /** settings.layouts, read and written whole. */
  saved(): Record<string, unknown>;
  store(layouts: Record<string, unknown>): void;
  screen: {
    displays(): Display[];
    primaryId(): number;
    /** The display a window with these bounds is (mostly) on. */
    displayOf(bounds: Rect): number;
  };
  /** Asks Matthew for a name; undefined when he cancels. */
  askName(): Promise<string | undefined>;
}

export class Layouts {
  constructor(private readonly deps: LayoutDeps) {}

  names(): string[] {
    return [...allLayouts(this.deps.saved()).keys()];
  }

  list(): LayoutSummary[] {
    return [...allLayouts(this.deps.saved())].map(([name, l]) => ({
      name,
      windows: l.windows.map((w) => w.windowId),
    }));
  }

  /** The layout the windows are in now, for the tray's check. */
  active(): string | undefined {
    const { screen, windows } = this.deps;
    return activeLayout(
      allLayouts(this.deps.saved()),
      windows.openWindows(),
      screen.displays(),
      screen.primaryId(),
      (id) => windows.minSize(id),
    );
  }

  /** Opens, moves and closes windows to match the layout ("work" finds Work mode). */
  apply(name: string): LayoutApplied {
    const layouts = allLayouts(this.deps.saved());
    const found = findLayout(name, [...layouts.keys()]);
    if (!found)
      throw new Error(`There's no layout called "${name}". Layouts: ${[...layouts.keys()].join(", ")}.`);
    const { screen, windows } = this.deps;
    const plan = planLayout(
      layouts.get(found)!,
      windows.windowIds(),
      screen.displays(),
      screen.primaryId(),
      (id) => windows.minSize(id),
    );
    for (const id of plan.close) windows.closeWindow(id);
    for (const { windowId, bounds } of plan.place) windows.placeWindow(windowId, bounds);
    return { name: found, windows: plan.place.map((p) => p.windowId) };
  }

  /** Stores the open windows under this name (replacing a saved one of the same name). */
  save(name: string): string | undefined {
    const clean = cleanName(name);
    if (!clean) return undefined;
    const { screen, windows } = this.deps;
    const layout = captureLayout(windows.openWindows(), screen.displays(), (b) => screen.displayOf(b));
    this.deps.store({ ...this.deps.saved(), [clean]: layout });
    return clean;
  }

  /** "Save current layout…": asks for a name, then saves. */
  async saveCurrent(): Promise<string | undefined> {
    const name = await this.deps.askName();
    return name === undefined ? undefined : this.save(name);
  }

  /** The answer to a layout.apply rpc from the server. */
  answer(payload: unknown): RpcAnswer {
    const name = (payload as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name.trim()) return { ok: false, error: "Which layout? Give its name." };
    try {
      return { ok: true, result: this.apply(name) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** AppleScript's text quoting. */
const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The osascript lines for the name prompt (a native dialog: the Desk has no window for it). */
export function namePromptScript(suggestion = ""): string[] {
  return [
    "-e",
    `text returned of (display dialog ${appleString("Name this layout")} default answer ${appleString(suggestion)} with title ${appleString("JARVIS Desk")} buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel")`,
  ];
}

/** Asks for a layout name with a macOS dialog; undefined on Cancel. */
export function askLayoutName(suggestion = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("osascript", namePromptScript(suggestion), { timeout: 5 * 60_000 }, (err, stdout) =>
      resolve(err ? undefined : stdout.replace(/\n$/, "")),
    );
  });
}

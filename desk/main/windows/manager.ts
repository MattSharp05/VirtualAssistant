// The window manager (JD-20): every feature opens in its own frameless window with macOS vibrancy
// behind the renderer's glass frame (app/WindowFrame.tsx). One window per feature id; its bounds are
// saved as it moves or resizes and restored next time, clamped to the displays that are connected.
import { join } from "node:path";
import { BrowserWindow, screen, shell } from "electron";
import { DEFAULT_MIN_SIZE, DEFAULT_SIZE, type FeatureMeta } from "../../renderer/features/types";
import { windowHash } from "../../renderer/app/router";
import type { Settings } from "../settings";
import { centred, restoreBounds, type Rect } from "./bounds";
import type { StackedWindow } from "./handWindows";
import { isExternalLink, parseWindowId } from "./target";

/** A feature's metadata, read from renderer/features/<id>/feature.ts (esbuild bundles every match). */
function featureMeta(id: string): FeatureMeta | undefined {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- esbuild turns this into a bundled glob
    return (require(`../../renderer/features/${id}/feature.ts`) as { default: FeatureMeta }).default;
  } catch {
    return undefined;
  }
}

export class WindowManager {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly listeners = new Set<() => void>();
  /** Window ids, most recently focused first (the front-to-back order camera hands pick from). */
  private order: string[] = [];

  constructor(
    private readonly rendererIndex: string,
    private readonly settings: Settings,
    private readonly scenario?: string,
  ) {}

  /**
   * Opens the feature's window, or shows and focuses it when it's already open. The id may carry
   * options ("today?section=inbox"): a separate window, given them in its hash. Params become the
   * hash query (`#/sessions?id=mk`) of the one window; an open window gets the new hash.
   */
  openWindow(id: string, params?: Record<string, string>): void {
    const hash = windowHash(id, params);
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (params) void existing.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      existing.show();
      existing.focus();
      return;
    }
    const target = parseWindowId(id);
    const meta = target && featureMeta(target.feature);
    if (!meta || meta.framed === false) {
      console.warn(`No window called "${id}"`);
      return;
    }
    const min = meta.minSize ?? DEFAULT_MIN_SIZE;
    const win = new BrowserWindow({
      ...this.initialBounds(id, meta),
      minWidth: min.width,
      minHeight: min.height,
      frame: false,
      vibrancy: "under-window",
      visualEffectState: "active",
      backgroundColor: "#00000000",
      show: false,
      title: meta.title,
      webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    this.windows.set(id, win);
    this.raise(id);
    win.on("focus", () => this.raise(id));
    win.once("ready-to-show", () => win.show());
    // Links (emails, Slack messages, events) open in the default browser, never in a new app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalLink(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!isExternalLink(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });
    const save = () => this.settings.setBounds(id, win.getBounds());
    win.on("moved", save);
    win.on("resized", save);
    win.on("closed", () => {
      this.windows.delete(id);
      this.order = this.order.filter((o) => o !== id);
      this.changed();
    });
    win.on("show", () => this.changed());
    win.on("hide", () => this.changed());
    void win.loadFile(this.rendererIndex, {
      hash,
      ...(this.scenario ? { query: { scenario: this.scenario } } : {}),
    });
  }

  closeWindow(id: string): void {
    this.windows.get(id)?.close();
  }

  /** Closes the window if it's showing, opens it otherwise. */
  toggleWindow(id: string): void {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed() && win.isVisible()) win.close();
    else this.openWindow(id);
  }

  /** The windows showing now and where they are (saved layouts, JD-37). */
  openWindows(): { windowId: string; bounds: Rect }[] {
    return [...this.windows]
      .filter(([, w]) => !w.isDestroyed() && w.isVisible())
      .map(([windowId, w]) => ({ windowId, bounds: w.getBounds() }));
  }

  /** Every window open now, showing or minimised. */
  windowIds(): string[] {
    return [...this.windows].filter(([, w]) => !w.isDestroyed()).map(([id]) => id);
  }

  /** Opens the window at these bounds, or moves it there when it's open (a layout being applied). */
  placeWindow(id: string, bounds: Rect): void {
    this.settings.setBounds(id, bounds);
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) {
      win.setBounds(bounds);
      win.show();
    } else this.openWindow(id);
  }

  /** A window's smallest size, from its feature.ts. */
  minSize(id: string): { width: number; height: number } {
    const target = parseWindowId(id);
    return (target && featureMeta(target.feature)?.minSize) ?? DEFAULT_MIN_SIZE;
  }

  /** The windows showing now, front to back, with their min sizes (camera hands, JD-47). */
  stack(): StackedWindow[] {
    return this.order.flatMap((id) => {
      const w = this.windows.get(id);
      if (!w || w.isDestroyed() || !w.isVisible()) return [];
      return [{ id, bounds: w.getBounds(), minSize: this.minSize(id) }];
    });
  }

  /** Moves or resizes a window for a hand gesture; `save` (the gesture's end) remembers the bounds. */
  setBounds(id: string, bounds: Rect, save: boolean): void {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) return;
    win.setBounds(bounds);
    if (save) this.settings.setBounds(id, win.getBounds());
  }

  /** Hides a window like its frame's minimise button (a flick, JD-47). */
  minimize(id: string): void {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.hide();
  }

  /** Called when a window opens, closes, shows or hides (moves reach settings.windowBounds). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private raise(id: string): void {
    this.order = [id, ...this.order.filter((o) => o !== id)];
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private initialBounds(id: string, meta: FeatureMeta): Rect {
    const primary = screen.getPrimaryDisplay().workArea;
    const saved = this.settings.bounds(id);
    if (!saved) return centred(meta.defaultSize ?? DEFAULT_SIZE, primary);
    return restoreBounds(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
      primary,
    );
  }
}

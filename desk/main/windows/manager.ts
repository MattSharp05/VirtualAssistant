// The window manager (JD-20): every feature opens in its own frameless window with macOS vibrancy
// behind the renderer's glass frame (app/WindowFrame.tsx). One window per feature id; its bounds are
// saved as it moves or resizes and restored next time, clamped to the displays that are connected.
import { join } from "node:path";
import { BrowserWindow, screen, shell } from "electron";
import { DEFAULT_MIN_SIZE, DEFAULT_SIZE, type FeatureMeta } from "../../renderer/features/types";
import { windowHash } from "../../renderer/app/router";
import type { Settings } from "../settings";
import { centred, restoreBounds, type Rect } from "./bounds";
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

const boundsKey = (id: string) => `window.${id}.bounds`;

export class WindowManager {
  private readonly windows = new Map<string, BrowserWindow>();

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
    const save = () => this.settings.set(boundsKey(id), win.getBounds());
    win.on("moved", save);
    win.on("resized", save);
    win.on("closed", () => this.windows.delete(id));
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

  private initialBounds(id: string, meta: FeatureMeta): Rect {
    const primary = screen.getPrimaryDisplay().workArea;
    const saved = this.settings.get<Rect>(boundsKey(id));
    if (!saved) return centred(meta.defaultSize ?? DEFAULT_SIZE, primary);
    return restoreBounds(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
      primary,
    );
  }
}

// Full views (JD-39): the real claude.ai session or notion.so page inside a Sessions or Notion window.
// Each window gets at most one WebContentsView, laid over the rect its renderer measures (below the
// title bar and tabs). All views share the persist:web partition, so signing in once keeps every
// window, and the next launch, signed in. Hiding a full view keeps it loaded for the next switch back.
import { BrowserWindow, ipcMain, session, shell, WebContentsView, type IpcMainEvent } from "electron";
import { chromeUserAgent, isInPlace, openTarget, viewBounds } from "./webPolicy";

const PARTITION = "persist:web";

interface FullView {
  view: WebContentsView;
  /** The last url the renderer asked for (the page may have moved on since). */
  url: string;
}

const views = new Map<BrowserWindow, FullView>();

function create(win: BrowserWindow): FullView {
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
  });
  view.setBackgroundColor("#11161c");
  view.webContents.setUserAgent(chromeUserAgent(process.versions.chrome));
  // Links to claude.ai or Notion navigate in place; anything else opens in the default browser.
  view.webContents.setWindowOpenHandler(({ url }) => {
    const target = openTarget(url);
    if (target === "in-place") void view.webContents.loadURL(url);
    if (target === "browser") void shell.openExternal(url);
    return { action: "deny" };
  });
  win.contentView.addChildView(view);
  win.once("closed", () => {
    views.delete(win);
    view.webContents.close();
  });
  const full = { view, url: "" };
  views.set(win, full);
  return full;
}

/** Shows (and, for a new url, loads) the sender window's full view over the given rect. */
function show(e: IpcMainEvent, url: unknown, rect: unknown): void {
  const win = BrowserWindow.fromWebContents(e.sender);
  const bounds = viewBounds(rect);
  if (!win || win.isDestroyed() || typeof url !== "string" || !isInPlace(url) || !bounds) return;
  const full = views.get(win) ?? create(win);
  if (full.url !== url) {
    full.url = url;
    void full.view.webContents.loadURL(url);
  }
  full.view.setBounds(bounds);
  full.view.setVisible(true);
}

/** Hides the sender window's full view; it stays loaded (and signed in) for next time. */
function hide(e: IpcMainEvent): void {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) views.get(win)?.view.setVisible(false);
}

/** The bridge's main side for full views (preload: desk.webview). Call once the app is ready. */
export function registerWebViews(): void {
  session.fromPartition(PARTITION).setUserAgent(chromeUserAgent(process.versions.chrome));
  ipcMain.on("desk:webview-show", show);
  ipcMain.on("desk:webview-hide", hide);
}

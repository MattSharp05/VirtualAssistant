// Full views (JD-39): the real claude.ai session or notion.so page inside a Sessions or Notion window.
// Each window gets at most one WebContentsView, laid over the rect its renderer measures (below the
// title bar and tabs). All views share the persist:web partition, so signing in once keeps every
// window, and the next launch, signed in. Hiding a full view keeps it loaded for the next switch back.
// Signing in (JD-68): Google, Apple and Microsoft sign-in popups open in a small sign-in window on the
// same partition (never the default browser, where the login would end up); when it closes or comes
// back to claude.ai / Notion, the full view reloads. Emailed sign-in links are pasted (openLink).
import { BrowserWindow, ipcMain, session, shell, WebContentsView, type IpcMainEvent } from "electron";
import type { FullViewSignIn } from "@jarvis/shared";
import {
  chromeUserAgent,
  isGoogleBlocked,
  isHome,
  isInPlace,
  isSignIn,
  navigateTarget,
  openTarget,
  viewBounds,
} from "./webPolicy";

const PARTITION = "persist:web";
const SIGN_IN_SIZE = { width: 500, height: 680 };
/**
 * After the sign-in window closes, the full view reloads unless the page moved on by itself within
 * this long (a popup sign-in hands its result to the page, which then signs in and navigates).
 */
const RELOAD_AFTER_MS = 1200;

interface FullView {
  view: WebContentsView;
  /** The last url the renderer asked for (the page may have moved on since). */
  url: string;
  /** Top-level navigations so far, to tell whether the page moved on after a sign-in window. */
  navigations: number;
  signIn: FullViewSignIn;
}

const views = new Map<BrowserWindow, FullView>();

/** Tells the window's renderer (its hint bar) when the sign-in state changes. */
function report(win: BrowserWindow, full: FullView, next: Partial<FullViewSignIn>): void {
  const state = { ...full.signIn, ...next };
  if (state.signInPage === full.signIn.signInPage && state.googleBlocked === full.signIn.googleBlocked)
    return;
  full.signIn = state;
  if (!win.isDestroyed()) win.webContents.send("desk:webview-signin", state);
}

/** The page the full view was asked for, again, now signed in. */
function reload(full: FullView): void {
  if (full.view.webContents.isDestroyed()) return;
  void full.view.webContents.loadURL(full.url || full.view.webContents.getURL());
}

/** Wires a sign-in window opened from a full view: Chrome's UA, its own popups, and how it ends. */
function signInWindow(win: BrowserWindow, full: FullView, child: BrowserWindow): void {
  child.webContents.setUserAgent(chromeUserAgent(process.versions.chrome));
  child.setMenuBarVisibility(false);
  // A provider's own popups stay in this window; anything else goes to the default browser.
  child.webContents.setWindowOpenHandler(({ url }) => {
    const target = openTarget(url);
    if (target === "sign-in" || target === "in-place") void child.webContents.loadURL(url);
    if (target === "browser") void shell.openExternal(url);
    return { action: "deny" };
  });
  child.webContents.on("did-navigate", (_e, url) => {
    if (isGoogleBlocked(url)) report(win, full, { googleBlocked: true });
    // Back on claude.ai or Notion proper: signed in (the full view reloads as the window closes).
    if (isHome(url)) child.close();
  });
  const before = full.navigations;
  child.once("closed", () => {
    setTimeout(() => {
      if (full.navigations === before) reload(full);
    }, RELOAD_AFTER_MS);
  });
}

function create(win: BrowserWindow): FullView {
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
  });
  view.setBackgroundColor("#11161c");
  view.webContents.setUserAgent(chromeUserAgent(process.versions.chrome));
  const full: FullView = {
    view,
    url: "",
    navigations: 0,
    signIn: { signInPage: false, googleBlocked: false },
  };
  // Sign-in popups open in a sign-in window that keeps its opener (popup sign-in posts its result back
  // to the page); links to claude.ai or Notion navigate in place; anything else opens in the default browser.
  view.webContents.setWindowOpenHandler(({ url }) => {
    const target = openTarget(url);
    if (target === "sign-in") {
      const bounds = win.getBounds();
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...SIGN_IN_SIZE,
          x: Math.round(bounds.x + (bounds.width - SIGN_IN_SIZE.width) / 2),
          y: Math.round(bounds.y + Math.max(0, (bounds.height - SIGN_IN_SIZE.height) / 2)),
          // A child window on top of its window, not a macOS sheet: a sheet has no close button.
          parent: win,
          minimizable: false,
          fullscreenable: false,
          title: "Sign in",
          backgroundColor: "#ffffff",
          webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
        },
      };
    }
    if (target === "in-place") void view.webContents.loadURL(url);
    if (target === "browser") void shell.openExternal(url);
    return { action: "deny" };
  });
  view.webContents.on("did-create-window", (child) => signInWindow(win, full, child));
  // Links followed in the page itself: claude.ai, Notion and sign-in pages stay, the rest go to the browser.
  view.webContents.on("will-navigate", (event, url) => {
    const target = navigateTarget(url, view.webContents.getURL());
    if (target === "allow") return;
    event.preventDefault();
    if (target === "browser") void shell.openExternal(url);
  });
  const navigated = (url: string) => {
    full.navigations++;
    report(win, full, {
      signInPage: isSignIn(url),
      googleBlocked: isGoogleBlocked(url) || (full.signIn.googleBlocked && !isHome(url)),
    });
  };
  view.webContents.on("did-navigate", (_e, url) => navigated(url));
  view.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && navigated(url));
  win.contentView.addChildView(view);
  win.once("closed", () => {
    views.delete(win);
    view.webContents.close();
  });
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
  // A renderer that (re)mounts gets the current state, e.g. on a sign-in page already.
  e.sender.send("desk:webview-signin", full.signIn);
}

/** Hides the sender window's full view; it stays loaded (and signed in) for next time. */
function hide(e: IpcMainEvent): void {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) views.get(win)?.view.setVisible(false);
}

/** "Sign in with a link" (JD-68): loads the pasted link in the sender window's full view. */
function openLink(e: IpcMainEvent, url: unknown): void {
  const win = BrowserWindow.fromWebContents(e.sender);
  const full = win && views.get(win);
  if (full && typeof url === "string" && isInPlace(url)) void full.view.webContents.loadURL(url);
}

/** Settings → Sign out of web views (JD-68): forgets the shared login, then reloads every full view. */
async function signOut(): Promise<void> {
  const web = session.fromPartition(PARTITION);
  await web.clearStorageData();
  await web.clearCache();
  for (const full of views.values()) reload(full);
}

/** The bridge's main side for full views (preload: desk.webview). Call once the app is ready. */
export function registerWebViews(): void {
  session.fromPartition(PARTITION).setUserAgent(chromeUserAgent(process.versions.chrome));
  ipcMain.on("desk:webview-show", show);
  ipcMain.on("desk:webview-hide", hide);
  ipcMain.on("desk:webview-open-link", openLink);
  ipcMain.handle("desk:webview-sign-out", signOut);
}

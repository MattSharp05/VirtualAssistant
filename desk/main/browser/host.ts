// The Electron side of the Mac's browser (JD-59): tabs are WebContentsViews in the Browser window, on
// their own persistent profile (persist:browser), each with a DevTools protocol session
// (webContents.debugger) the agent acts through. The active tab is laid over the rect the window's
// renderer measures (like full views, windows/webview.ts); pages that open windows get tabs instead.
// Downloads go to ~/Downloads; file pickers never open (Page.setInterceptFileChooserDialog).
// Closing the Browser window closes its tabs (the profile keeps the sign-ins).
import { existsSync } from "node:fs";
import {
  BrowserWindow,
  ipcMain,
  session,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import type {
  BrowserCommand,
  BrowserControl,
  BrowserState,
  BrowserTab,
  DeskEvent,
  UploadResponse,
} from "@jarvis/shared";
import type { UploadSource } from "../uploads";
import { chromeUserAgent, viewBounds, type ViewBounds } from "../windows/webPolicy";
import { BrowserAgent, type BrowserTabHandle, type BrowserTabsHost, type Cdp } from "./agent";
import {
  addressToUrl,
  BROWSER_PARTITION,
  BrowserInputError,
  downloadPath,
  isBrowsable,
  tabTitle,
} from "./policy";
import { browserCommand } from "./validate";

/** Where the page sits before the renderer has measured it: below the title bar, tabs, toolbar and status. */
export const DEFAULT_PAGE_TOP = 162;
const LOAD_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Tab {
  id: string;
  view: WebContentsView;
  cdp: Cdp;
  /** Bumped on every main-frame navigation: a new document. */
  doc: number;
}

export interface BrowserHostDeps {
  /** The Browser window, when it's open. */
  window(): BrowserWindow | undefined;
  openWindow(): void;
  publish(event: DeskEvent): void;
  /** Who drives, and the task's status line (the agent's). */
  control(): { control: BrowserControl; status?: string };
  takeOver(): void;
  handBack(): void;
}

/** Waits until the page has stopped loading (a click may start a navigation a moment later). */
async function settle(wc: WebContents, ms: number): Promise<void> {
  await sleep(150);
  if (!wc.isDestroyed() && wc.isLoading())
    await Promise.race([new Promise<void>((r) => wc.once("did-stop-loading", () => r())), sleep(ms)]);
  await sleep(250);
}

export class ElectronBrowserHost implements BrowserTabsHost {
  private list: Tab[] = [];
  private activeId?: string;
  /** The page's rect in the window, as its renderer measured it. */
  private bounds?: ViewBounds;
  private visible = true;
  private attachedTo?: BrowserWindow;
  private next = 1;
  private publishing = false;

  constructor(private readonly deps: BrowserHostDeps) {}

  // ── BrowserTabsHost (the agent's side) ──

  async ensureWindow(): Promise<void> {
    let win = this.deps.window();
    if (!win) {
      this.deps.openWindow();
      for (let i = 0; i < 50 && !(win = this.deps.window()); i++) await sleep(100);
    }
    if (!win) throw new Error("The Browser window didn't open.");
    this.attach(win);
  }

  tabs(): BrowserTab[] {
    return this.list.map((t) => {
      const wc = t.view.webContents;
      return {
        id: t.id,
        url: wc.getURL(),
        title: tabTitle(wc.getTitle(), wc.getURL()),
        active: t.id === this.activeId,
      };
    });
  }

  active(): BrowserTabHandle | undefined {
    const tab = this.activeTab();
    return tab && this.handle(tab);
  }

  async open(url: string, newTab: boolean): Promise<BrowserTabHandle> {
    let tab = newTab ? undefined : this.activeTab();
    if (!tab) tab = this.create();
    this.activate(tab.id);
    await this.load(tab, url);
    return this.handle(tab);
  }

  switchTo(tabId: string): boolean {
    if (!this.list.some((t) => t.id === tabId)) return false;
    this.activate(tabId);
    return true;
  }

  close(tabId: string): boolean {
    const i = this.list.findIndex((t) => t.id === tabId);
    if (i < 0) return false;
    const [tab] = this.list.splice(i, 1);
    this.attachedTo?.contentView.removeChildView(tab!.view);
    tab!.view.webContents.close();
    if (this.activeId === tabId) this.activeId = (this.list[i] ?? this.list[i - 1])?.id;
    this.layout();
    this.changed();
    return true;
  }

  // ── The window's side (preload: desk.browser) ──

  state(): BrowserState {
    const tab = this.activeTab();
    const wc = tab?.view.webContents;
    const { control, status } = this.deps.control();
    return {
      tabs: this.tabs(),
      url: wc?.getURL() ?? "",
      title: wc ? tabTitle(wc.getTitle(), wc.getURL()) : "",
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false,
      control,
      ...(status ? { status } : {}),
    };
  }

  /** Matthew's toolbar and tab strip: they work whoever has control. */
  command(input: unknown): void {
    const command: BrowserCommand | undefined = browserCommand(input);
    if (!command) return;
    const wc = this.activeTab()?.view.webContents;
    switch (command.type) {
      case "go": {
        const url = addressToUrl(command.address);
        if (!url) return;
        const tab = this.activeTab() ?? this.create();
        this.activate(tab.id);
        void this.load(tab, url).catch((err) => console.warn("browser:", err));
        return;
      }
      case "back":
        if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return;
      case "forward":
        if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        return;
      case "reload":
        wc?.reload();
        return;
      case "new-tab":
        this.activate(this.create().id);
        return;
      case "switch-tab":
        this.switchTo(command.tabId);
        return;
      case "close-tab":
        this.close(command.tabId);
        return;
      case "take-over":
        this.deps.takeOver();
        return;
      case "hand-back":
        this.deps.handBack();
        return;
    }
  }

  /** The renderer measured the page's slot; only the Browser window's own renderer counts. */
  show(e: IpcMainEvent, rect: unknown): void {
    const win = this.deps.window();
    const bounds = viewBounds(rect);
    if (!win || BrowserWindow.fromWebContents(e.sender) !== win || !bounds) return;
    this.bounds = bounds;
    this.visible = true;
    this.attach(win);
    this.layout();
  }

  hide(e: IpcMainEvent): void {
    const win = this.deps.window();
    if (!win || BrowserWindow.fromWebContents(e.sender) !== win) return;
    this.visible = false;
    this.layout();
  }

  /** Tells the window something changed (coalesced: a page load fires several events at once). */
  changed(): void {
    if (this.publishing) return;
    this.publishing = true;
    setTimeout(() => {
      this.publishing = false;
      this.deps.publish({ type: "browser.state", state: this.state() });
    }, 16);
  }

  // ── tabs ──

  private activeTab(): Tab | undefined {
    return this.list.find((t) => t.id === this.activeId);
  }

  private activate(tabId: string): void {
    this.activeId = tabId;
    this.layout();
    this.changed();
  }

  private create(): Tab {
    const view = new WebContentsView({
      webPreferences: { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true },
    });
    view.setBackgroundColor("#ffffff");
    const wc = view.webContents;
    wc.setUserAgent(chromeUserAgent(process.versions.chrome));
    const cdp: Cdp = {
      send: async <T>(method: string, params?: Record<string, unknown>) => {
        if (!wc.debugger.isAttached()) this.attachDebugger(wc);
        return (await wc.debugger.sendCommand(method, params)) as T;
      },
    };
    const tab: Tab = { id: `tab-${this.next++}`, view, cdp, doc: 0 };
    this.attachDebugger(wc);
    // A page's new windows (target=_blank, window.open) become tabs.
    wc.setWindowOpenHandler(({ url }) => {
      if (isBrowsable(url) && url !== "about:blank") {
        const opened = this.create();
        this.activate(opened.id);
        void this.load(opened, url).catch((err) => console.warn("browser:", err));
      } else if (/^mailto:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (isBrowsable(url)) return;
      event.preventDefault();
      if (/^mailto:/i.test(url)) void shell.openExternal(url);
    });
    wc.on("did-navigate", () => {
      tab.doc++;
      void this.prepare(tab);
      this.changed();
    });
    wc.on("did-navigate-in-page", () => this.changed());
    wc.on("page-title-updated", () => this.changed());
    wc.on("did-start-loading", () => this.changed());
    wc.on("did-stop-loading", () => this.changed());
    this.list.push(tab);
    if (this.attachedTo && !this.attachedTo.isDestroyed()) this.attachedTo.contentView.addChildView(view);
    void this.prepare(tab);
    this.changed();
    return tab;
  }

  private attachDebugger(wc: WebContents): void {
    try {
      wc.debugger.attach("1.3");
    } catch (err) {
      console.warn("browser: DevTools protocol:", err instanceof Error ? err.message : err);
    }
  }

  /** What every document needs: the domains the agent uses, and no file picker. */
  private async prepare(tab: Tab): Promise<void> {
    try {
      await tab.cdp.send("Page.enable");
      await tab.cdp.send("DOM.enable");
      await tab.cdp.send("Accessibility.enable");
      await tab.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
    } catch (err) {
      console.warn("browser: preparing the page:", err instanceof Error ? err.message : err);
    }
  }

  private async load(tab: Tab, url: string): Promise<void> {
    const loading = tab.view.webContents.loadURL(url).catch((err: { code?: string; message?: string }) => {
      // A redirect or a page that moves on aborts the first load: not a failure.
      if (err.code === "ERR_ABORTED") return;
      throw new BrowserInputError(`Couldn't open ${url}: ${err.code ?? err.message ?? "it didn't load"}.`);
    });
    await Promise.race([loading, sleep(LOAD_MS)]);
  }

  private handle(tab: Tab): BrowserTabHandle {
    const wc = tab.view.webContents;
    return {
      id: tab.id,
      cdp: tab.cdp,
      url: () => wc.getURL(),
      title: () => tabTitle(wc.getTitle(), wc.getURL()),
      documentId: () => `${tab.id}.${tab.doc}`,
      canGoBack: () => wc.navigationHistory.canGoBack(),
      canGoForward: () => wc.navigationHistory.canGoForward(),
      back: () => wc.navigationHistory.goBack(),
      forward: () => wc.navigationHistory.goForward(),
      reload: () => wc.reload(),
      settle: (ms) => settle(wc, ms),
    };
  }

  // ── the window ──

  private attach(win: BrowserWindow): void {
    if (this.attachedTo === win) return;
    this.attachedTo = win;
    for (const tab of this.list) win.contentView.addChildView(tab.view);
    win.on("resize", () => this.layout());
    win.once("closed", () => {
      this.attachedTo = undefined;
      this.bounds = undefined;
      for (const tab of this.list.splice(0)) tab.view.webContents.close();
      this.activeId = undefined;
      this.changed();
    });
    this.layout();
  }

  /** The active tab over the page's slot; the others hidden. */
  private layout(): void {
    const win = this.attachedTo;
    if (!win || win.isDestroyed()) return;
    const [width = 0, height = 0] = win.getContentSize();
    const bounds = this.bounds ?? {
      x: 1,
      y: DEFAULT_PAGE_TOP,
      width: Math.max(0, width - 2),
      height: Math.max(0, height - DEFAULT_PAGE_TOP - 1),
    };
    for (const tab of this.list) {
      const on = tab.id === this.activeId && this.visible;
      if (on) tab.view.setBounds(bounds);
      tab.view.setVisible(on);
    }
  }
}

export interface BrowserDeps {
  window(): BrowserWindow | undefined;
  openWindow(): void;
  publish(event: DeskEvent): void;
  upload(source: UploadSource): Promise<UploadResponse>;
  downloadsDir: string;
}

/** The browser's agent (for the rpc handlers) and the bridge's main side. Call once the app is ready. */
export function registerBrowser(deps: BrowserDeps): BrowserAgent {
  // eslint-disable-next-line prefer-const -- the host and the agent refer to each other
  let agent: BrowserAgent;
  const host = new ElectronBrowserHost({
    window: deps.window,
    openWindow: deps.openWindow,
    publish: deps.publish,
    control: () => ({ control: agent.control, ...(agent.status ? { status: agent.status } : {}) }),
    takeOver: () => agent.takeOver(),
    handBack: () => agent.handBack(),
  });
  agent = new BrowserAgent({
    host,
    announce: (caption, ref, rect) =>
      deps.publish({
        type: "browser.action",
        caption,
        ...(ref !== undefined ? { ref } : {}),
        ...(rect ? { rect } : {}),
      }),
    changed: () => host.changed(),
    upload: deps.upload,
  });
  const profile = session.fromPartition(BROWSER_PARTITION);
  profile.setUserAgent(chromeUserAgent(process.versions.chrome));
  profile.on("will-download", (_e, item) =>
    item.setSavePath(downloadPath(deps.downloadsDir, item.getFilename(), existsSync)),
  );
  ipcMain.handle("desk:browser-state", () => host.state());
  ipcMain.handle("desk:browser-command", (_e, command: unknown) => host.command(command));
  ipcMain.on("desk:browser-show", (e, rect: unknown) => host.show(e, rect));
  ipcMain.on("desk:browser-hide", (e) => host.hide(e));
  return agent;
}

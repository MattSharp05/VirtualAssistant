// The browser actions JARVIS can call (JD-59), done in the active tab over its DevTools protocol.
// Each one checks Matthew hasn't taken over, shows what it's about to do (the window's caption, and a
// ring around the element for RING_MS), acts, waits for the page to settle and answers with the page
// it left: URL, title and whether it changed. No Electron in here: tabs come in as BrowserTabsHost
// (host.ts), so tests drive it with fakes.
import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  BROWSER_TAKEN_OVER,
  BROWSER_WAIT_MAX_MS,
  type BrowserActionResult,
  type BrowserClickRequest,
  type BrowserControl,
  type BrowserNavigateRequest,
  type BrowserOpenRequest,
  type BrowserPressRequest,
  type BrowserRect,
  type BrowserScreenshotResult,
  type BrowserScrollRequest,
  type BrowserSelectRequest,
  type BrowserSnapshotRequest,
  type BrowserSnapshotResult,
  type BrowserStatusRequest,
  type BrowserTab,
  type BrowserTabsRequest,
  type BrowserTypeRequest,
  type BrowserWaitRequest,
  type UploadResponse,
} from "@jarvis/shared";
import type { UploadSource } from "../uploads";
import { actionOverlayScript, FINGERPRINT_SCRIPT, RING_MS, short } from "./actionOverlay";
import { checkClick, checkType, FIELD_INFO, fieldInfo, type GuardTarget } from "./guard";
import { keyEvent } from "./keys";
import { BrowserInputError } from "./policy";
import { RefTable, snapshotLines, snapshotPart, type AXNode } from "./snapshot";

/** A DevTools protocol session on one tab (webContents.debugger). */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface BrowserTabHandle {
  readonly id: string;
  url(): string;
  title(): string;
  /** Changes whenever the tab shows a new document (the refs start again). */
  documentId(): string;
  readonly cdp: Cdp;
  canGoBack(): boolean;
  canGoForward(): boolean;
  back(): void;
  forward(): void;
  reload(): void;
  /** Resolves once the page has stopped loading, or after `ms`. */
  settle(ms: number): Promise<void>;
}

export interface BrowserTabsHost {
  /** Opens the Browser window when it's closed (JARVIS's pages are always on screen). */
  ensureWindow(): Promise<void>;
  tabs(): BrowserTab[];
  active(): BrowserTabHandle | undefined;
  /** Loads the url in the active tab, or a new one (also when there's no tab yet). */
  open(url: string, newTab: boolean): Promise<BrowserTabHandle>;
  switchTo(tabId: string): boolean;
  close(tabId: string): boolean;
}

export interface BrowserAgentDeps {
  host: BrowserTabsHost;
  /** The Browser window's caption, and the element (ref, viewport rect) about to be touched. */
  announce(caption: string, ref?: number, rect?: BrowserRect): void;
  /** Who has control, or the status line, changed. */
  changed(): void;
  upload(source: UploadSource): Promise<UploadResponse>;
  wait?(ms: number): Promise<void>;
  now?(): Date;
}

/** Refused because Matthew has the browser; the brain waits until he hands back. */
export class BrowserTakenOver extends Error {
  constructor() {
    super(BROWSER_TAKEN_OVER);
  }
}

/** How long an action waits for the page to settle afterwards. */
export const SETTLE_MS = 8_000;
const POLL_MS = 250;
/** Screenshot attempts, best first, until one fits BROWSER_SCREENSHOT_MAX_BYTES. */
export const SHOT_STEPS = [
  { quality: 80, scale: 1 },
  { quality: 60, scale: 1 },
  { quality: 45, scale: 1 },
  { quality: 45, scale: 0.75 },
  { quality: 35, scale: 0.5 },
  { quality: 25, scale: 0.4 },
];

interface BoxModel {
  model: { content: number[]; width: number; height: number };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The first screenshot that fits, trying SHOT_STEPS in turn. */
export async function fitScreenshot(
  capture: (quality: number, scale: number) => Promise<Uint8Array>,
  max = BROWSER_SCREENSHOT_MAX_BYTES,
): Promise<{ bytes: Uint8Array; scale: number }> {
  for (const { quality, scale } of SHOT_STEPS) {
    const bytes = await capture(quality, scale);
    if (bytes.length <= max) return { bytes, scale };
  }
  throw new Error("The page's screenshot wouldn't fit in 300 KB.");
}

/** "browser-2026-10-17-091200.jpg" */
export function screenshotName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `browser-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.jpg`;
}

export class BrowserAgent {
  private controlBy: BrowserControl = "jarvis";
  private statusLine?: string;
  private readonly refs = new Map<string, RefTable>();
  /** Each tab's fingerprint after JARVIS last acted on or read it. */
  private readonly prints = new Map<string, string>();

  constructor(private readonly deps: BrowserAgentDeps) {}

  get control(): BrowserControl {
    return this.controlBy;
  }

  get status(): string | undefined {
    return this.statusLine;
  }

  /** Matthew's Take over: every action is refused until handBack(). */
  takeOver(): void {
    this.setControl("matthew");
  }

  handBack(): void {
    this.setControl("jarvis");
  }

  /** browser.status: the task's line in the toolbar (allowed while Matthew drives; it touches no page). */
  async setStatus({ text }: BrowserStatusRequest): Promise<{ status?: string }> {
    this.statusLine = text;
    this.deps.changed();
    return text ? { status: text } : {};
  }

  async open({ url, newTab }: BrowserOpenRequest): Promise<BrowserActionResult> {
    await this.ready();
    this.deps.announce(`Opening ${short(hostOf(url), 60)}`);
    const tab = await this.deps.host.open(url, newTab === true);
    await tab.settle(SETTLE_MS);
    return { ...(await this.result(tab)), tabs: this.deps.host.tabs() };
  }

  async navigate({ action }: BrowserNavigateRequest): Promise<BrowserActionResult> {
    const tab = await this.tab();
    if (action === "back") {
      if (!tab.canGoBack()) throw new BrowserInputError("There's no page to go back to.");
      this.deps.announce("Going back");
      tab.back();
    } else if (action === "forward") {
      if (!tab.canGoForward()) throw new BrowserInputError("There's no page to go forward to.");
      this.deps.announce("Going forward");
      tab.forward();
    } else {
      this.deps.announce("Reloading");
      tab.reload();
    }
    await tab.settle(SETTLE_MS);
    return this.result(tab);
  }

  async tabs(request: BrowserTabsRequest): Promise<BrowserActionResult> {
    await this.ready();
    const { host } = this.deps;
    if (request.action !== "list") {
      const id = request.tabId!;
      const ok = request.action === "switch" ? host.switchTo(id) : host.close(id);
      if (!ok) throw new BrowserInputError(`There's no tab ${id}; browser.tabs lists them.`);
    }
    const tab = host.active();
    const page = tab ? await this.result(tab) : { url: "", title: "", change: "page changed" as const };
    return { ...page, tabs: host.tabs() };
  }

  async snapshot({ more }: BrowserSnapshotRequest): Promise<BrowserSnapshotResult> {
    const tab = await this.tab();
    const refs = this.refTable(tab);
    const { nodes } = await tab.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const lines = snapshotLines(nodes ?? [], refs);
    const part = snapshotPart(
      lines,
      { title: tab.title(), url: tab.url(), documentId: tab.documentId() },
      more,
    );
    return { ...(await this.result(tab)), ...part };
  }

  async click({ ref, task }: BrowserClickRequest): Promise<BrowserActionResult> {
    const tab = await this.tab();
    const { entry, rect } = await this.target(tab, ref);
    // JD-60: a risky button needs Matthew's approval in Normal mode (guard.ts), before anything shows.
    checkClick(await this.guardTarget(tab, entry), task);
    await this.show(tab, `Clicking ${quoted(entry.name, entry.role)}`, ref, rect);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await tab.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await tab.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await tab.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await tab.settle(SETTLE_MS);
    return this.result(tab);
  }

  async type({ ref, text, submit }: BrowserTypeRequest): Promise<BrowserActionResult> {
    const tab = await this.tab();
    const { entry, rect } = await this.target(tab, ref);
    // JD-60: passwords, one-time codes and card details are Matthew's to type, in every mode.
    checkType(await this.guardTarget(tab, entry));
    const secret = /password|passcode|pin\b/i.test(entry.name);
    const what = secret ? "••••" : `‘${short(text, 30)}’`;
    await this.show(tab, `Typing ${what} into ${quoted(entry.name, entry.role)}`, ref, rect);
    await tab.cdp.send("DOM.focus", { backendNodeId: entry.backendNodeId });
    // Replace what's there: select it all, then type over it (or delete it for empty text).
    await this.callOn(tab, entry.backendNodeId, SELECT_ALL);
    if (text) await tab.cdp.send("Input.insertText", { text });
    else await this.key(tab, "Backspace");
    if (submit) await this.key(tab, "Enter");
    await tab.settle(SETTLE_MS);
    return this.result(tab);
  }

  async select({ ref, option }: BrowserSelectRequest): Promise<BrowserActionResult> {
    const tab = await this.tab();
    const { entry, rect } = await this.target(tab, ref);
    await this.show(tab, `Choosing ‘${short(option, 30)}’ in ${quoted(entry.name, entry.role)}`, ref, rect);
    const picked = (await this.callOn(tab, entry.backendNodeId, PICK_OPTION, [option])) as
      { label?: string; error?: string; options?: string[] } | undefined;
    if (picked?.error === "not-select")
      throw new BrowserInputError(`[${ref}] isn't a list of options; click it and then click the option.`);
    if (picked?.error)
      throw new BrowserInputError(
        `[${ref}] has no option “${option}”. It has: ${(picked.options ?? []).slice(0, 30).join(", ")}.`,
      );
    await tab.settle(SETTLE_MS);
    return this.result(tab);
  }

  async press({ key }: BrowserPressRequest): Promise<BrowserActionResult> {
    keyEvent(key); // a wrong key is refused before anything shows
    const tab = await this.tab();
    await this.show(tab, `Pressing ${key}`);
    await this.key(tab, key);
    await tab.settle(SETTLE_MS);
    return this.result(tab);
  }

  async scroll({ direction, ref }: BrowserScrollRequest): Promise<BrowserActionResult> {
    const tab = await this.tab();
    if (ref !== undefined) {
      const { entry, rect } = await this.target(tab, ref);
      await this.show(tab, `Scrolling to ${quoted(entry.name, entry.role)}`, ref, rect);
    } else {
      const dir = direction ?? "down";
      await this.show(
        tab,
        dir === "top" || dir === "bottom" ? `Scrolling to the ${dir}` : `Scrolling ${dir}`,
      );
      if (dir === "top" || dir === "bottom")
        await this.evaluate(
          tab,
          `scrollTo({ top: ${dir === "top" ? 0 : "document.documentElement.scrollHeight"} })`,
        );
      else {
        const { width, height } = await this.viewport(tab);
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: width / 2,
          y: height / 2,
          deltaX: 0,
          deltaY: Math.round(height * 0.8) * (dir === "up" ? -1 : 1),
        });
      }
    }
    await this.pause(POLL_MS);
    return this.result(tab);
  }

  async wait({ text, ms }: BrowserWaitRequest): Promise<BrowserActionResult> {
    const tab = await this.tab();
    if (text === undefined) {
      await this.pause(Math.min(ms ?? 0, BROWSER_WAIT_MAX_MS));
      return this.result(tab);
    }
    this.deps.announce(`Waiting for ‘${short(text, 40)}’`);
    const probe = `(document.body ? document.body.innerText : "").toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
    for (let waited = 0; ; waited += POLL_MS) {
      if ((await this.evaluate(tab, probe).catch(() => false)) === true) return this.result(tab);
      if (waited >= BROWSER_WAIT_MAX_MS)
        throw new BrowserInputError(`“${text}” didn't appear on the page within 15 s.`);
      this.guard(); // Matthew may take over while JARVIS waits
      await this.pause(POLL_MS);
    }
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    const tab = await this.tab();
    const { width, height } = await this.viewport(tab);
    const { bytes, scale } = await fitScreenshot(async (quality, s) => {
      const { data } = await tab.cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        ...(s === 1 ? {} : { clip: { x: 0, y: 0, width, height, scale: s } }),
      });
      return new Uint8Array(Buffer.from(data, "base64"));
    });
    const at = (this.deps.now ?? (() => new Date()))();
    const upload = await this.deps.upload({ name: screenshotName(at), bytes });
    return {
      ...(await this.result(tab)),
      upload,
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  }

  // ── helpers ──

  private setControl(control: BrowserControl): void {
    if (control === this.controlBy) return;
    this.controlBy = control;
    this.deps.changed();
  }

  private guard(): void {
    if (this.controlBy === "matthew") throw new BrowserTakenOver();
  }

  /** Every action starts here: Matthew hasn't taken over, and the window is open. */
  private async ready(): Promise<void> {
    this.guard();
    await this.deps.host.ensureWindow();
  }

  private async tab(): Promise<BrowserTabHandle> {
    await this.ready();
    const tab = this.deps.host.active();
    if (!tab) throw new BrowserInputError("No page is open; browser.open opens one.");
    return tab;
  }

  private refTable(tab: BrowserTabHandle): RefTable {
    let refs = this.refs.get(tab.id);
    if (!refs) this.refs.set(tab.id, (refs = new RefTable()));
    refs.sync(tab.documentId());
    return refs;
  }

  /** The element behind a ref, scrolled into view, and where it is in the viewport. */
  private async target(tab: BrowserTabHandle, ref: number) {
    const entry = this.refTable(tab).get(ref);
    if (!entry)
      throw new BrowserInputError(`There's no [${ref}] on this page; take a snapshot for the current refs.`);
    const backendNodeId = entry.backendNodeId;
    let box: BoxModel;
    try {
      await tab.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      box = await tab.cdp.send<BoxModel>("DOM.getBoxModel", { backendNodeId });
    } catch (err) {
      throw new BrowserInputError(
        `[${ref}] isn't on the page any more (${message(err)}); take a new snapshot.`,
      );
    }
    const q = box.model.content;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    const rect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    if (rect.width < 1 || rect.height < 1) throw new BrowserInputError(`[${ref}] isn't visible on the page.`);
    return { entry, rect };
  }

  /** What guard.ts looks at: the snapshot's role and name, and the element's type and autocomplete. */
  private async guardTarget(
    tab: BrowserTabHandle,
    entry: { backendNodeId: number; role: string; name: string },
  ): Promise<GuardTarget> {
    const info = fieldInfo(await this.callOn(tab, entry.backendNodeId, FIELD_INFO).catch(() => undefined));
    return { role: entry.role, name: entry.name, ...info };
  }

  /** The caption in the window and in the page, with the ring around `rect` for RING_MS first. */
  private async show(
    tab: BrowserTabHandle,
    caption: string,
    ref?: number,
    rect?: BrowserRect,
  ): Promise<void> {
    this.deps.announce(caption, ref, rect);
    await this.evaluate(tab, actionOverlayScript(caption, rect)).catch(() => {});
    if (rect) await this.pause(RING_MS);
    this.guard(); // Matthew took over while the ring showed: don't touch his page
  }

  private async key(tab: BrowserTabHandle, spec: string): Promise<void> {
    const k = keyEvent(spec);
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      modifiers: k.modifiers,
    };
    await tab.cdp.send("Input.dispatchKeyEvent", {
      ...base,
      type: k.text ? "keyDown" : "rawKeyDown",
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
    await tab.cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  private async evaluate(tab: BrowserTabHandle, expression: string): Promise<unknown> {
    const { result, exceptionDetails } = await tab.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "The page's script failed.");
    return result?.value;
  }

  /** Runs `fn` with `this` = the element (DOM.resolveNode + Runtime.callFunctionOn). */
  private async callOn(tab: BrowserTabHandle, backendNodeId: number, fn: string, args: unknown[] = []) {
    const { object } = await tab.cdp.send<{ object: { objectId?: string } }>("DOM.resolveNode", {
      backendNodeId,
    });
    const { result } = await tab.cdp.send<{ result?: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    return result?.value;
  }

  private async viewport(tab: BrowserTabHandle): Promise<{ width: number; height: number }> {
    const metrics = await tab.cdp.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
      "Page.getLayoutMetrics",
    );
    const v = metrics.cssVisualViewport;
    return { width: Math.round(v?.clientWidth ?? 1024), height: Math.round(v?.clientHeight ?? 768) };
  }

  /** The page now, and whether it changed since JARVIS last acted on or read this tab. */
  private async result(tab: BrowserTabHandle): Promise<BrowserActionResult> {
    const print = `${tab.documentId()}|${String(await this.evaluate(tab, FINGERPRINT_SCRIPT).catch(() => Math.random()))}`;
    const before = this.prints.get(tab.id);
    this.prints.set(tab.id, print);
    return { url: tab.url(), title: tab.title(), change: before === print ? "same page" : "page changed" };
  }

  private pause(ms: number): Promise<void> {
    return (this.deps.wait ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);
  }
}

/** ‘Check availability’, or the role when the element has no name (‘the textbox’). */
function quoted(name: string, role: string): string {
  return name ? `‘${short(name)}’` : `the ${role}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Selects a field's whole text, so typing replaces it. */
const SELECT_ALL = `function () {
  if (typeof this.select === "function") this.select();
  else if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}`;

/** Picks a <select>'s option by label (exact, then partial) or value, as a person would. */
const PICK_OPTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { error: "not-select" };
  const want = String(wanted).trim().toLowerCase();
  const options = Array.from(this.options);
  const option =
    options.find((o) => o.label.trim().toLowerCase() === want) ||
    options.find((o) => o.value.toLowerCase() === want) ||
    options.find((o) => o.label.toLowerCase().includes(want));
  if (!option) return { error: "no-option", options: options.map((o) => o.label.trim()) };
  this.focus();
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { label: option.label };
}`;

import { describe, expect, it } from "vitest";
import {
  BROWSER_NEEDS_APPROVAL,
  BROWSER_NEEDS_MATTHEW,
  type BrowserTab,
  type DeskEvent,
} from "@jarvis/shared";
import { answerRpc } from "../rpcHandlers";
import { browserRpcHandlers } from "../rpcHandlers/browser";
import { RING_MS } from "./actionOverlay";
import {
  BrowserAgent,
  fitScreenshot,
  screenshotName,
  type BrowserTabHandle,
  type BrowserTabsHost,
} from "./agent";
import { bookingNodes } from "./fixtures";

/** One tab whose DevTools protocol answers from canned data and records every call. */
class FakeTab implements BrowserTabHandle {
  calls: { method: string; params?: Record<string, unknown> }[] = [];
  page = { url: "https://reservas.example/taberna", title: "Book a table", doc: 1, print: "p1" };
  bodyText = "Tables for up to 8";
  history = { back: false, forward: false };
  /** What a click on the button does to the page. */
  onClick?: () => void;
  selectAnswer: unknown = { label: "6 people" };
  shotSizes: number[] = [400_000, 250_000];

  constructor(readonly id = "tab-1") {}

  url = () => this.page.url;
  title = () => this.page.title;
  documentId = () => `${this.id}.${this.page.doc}`;
  canGoBack = () => this.history.back;
  canGoForward = () => this.history.forward;
  back = () => {
    this.page = { ...this.page, url: "https://reservas.example/", doc: this.page.doc + 1, print: "home" };
  };
  forward = () => {};
  reload = () => {};
  settle = async () => {};

  cdp = {
    send: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      this.calls.push(params ? { method, params } : { method });
      return this.answer(method, params) as T;
    },
  };

  private answer(method: string, params?: Record<string, unknown>): unknown {
    switch (method) {
      case "Accessibility.getFullAXTree":
        return { nodes: bookingNodes() };
      case "DOM.getBoxModel":
        if (params?.backendNodeId === 999) throw new Error("No node with given id found");
        return { model: { content: [100, 200, 260, 200, 260, 240, 100, 240], width: 160, height: 40 } };
      case "DOM.resolveNode":
        return { object: { objectId: `obj-${String(params?.backendNodeId)}` } };
      case "Runtime.callFunctionOn":
        return {
          result: {
            value: String(params?.functionDeclaration).includes("HTMLSelectElement")
              ? this.selectAnswer
              : undefined,
          },
        };
      case "Runtime.evaluate": {
        const expr = String(params?.expression);
        if (expr.includes("location.href")) return { result: { value: this.page.print } };
        if (expr.includes('innerText : "").toLowerCase()'))
          return {
            result: {
              value: expr.includes(JSON.stringify("table for 4")) && this.bodyText.includes("table for 4"),
            },
          };
        return { result: {} };
      }
      case "Input.dispatchMouseEvent":
        if (params?.type === "mouseReleased") this.onClick?.();
        return {};
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } };
      case "Page.captureScreenshot": {
        const size = this.shotSizes.shift() ?? 1000;
        return { data: Buffer.alloc(size).toString("base64") };
      }
      default:
        return {};
    }
  }

  called(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

function setup() {
  let tab: FakeTab | undefined;
  const opened: { url: string; newTab: boolean }[] = [];
  const events: DeskEvent[] = [];
  const waits: number[] = [];
  let changes = 0;
  let windows = 0;
  const host: BrowserTabsHost = {
    ensureWindow: async () => void windows++,
    tabs: (): BrowserTab[] => (tab ? [{ id: tab.id, url: tab.url(), title: tab.title(), active: true }] : []),
    active: () => tab,
    open: async (url, newTab) => {
      opened.push({ url, newTab });
      tab ??= new FakeTab();
      tab.page = { url, title: "Taberna da Rua", doc: tab.page.doc + 1, print: url };
      return tab;
    },
    switchTo: (id) => id === tab?.id,
    close: (id) => id === tab?.id,
  };
  const agent = new BrowserAgent({
    host,
    announce: (caption, ref, rect) =>
      events.push({ type: "browser.action", caption, ...(ref ? { ref } : {}), ...(rect ? { rect } : {}) }),
    changed: () => void changes++,
    upload: async (source) => ({ id: "u1", path: `/data/uploads/u1/${source.name}`, name: source.name }),
    wait: async (ms) => void waits.push(ms),
    now: () => new Date(2026, 9, 17, 9, 12, 0),
  });
  return {
    agent,
    opened,
    events,
    waits,
    get changes() {
      return changes;
    },
    get windows() {
      return windows;
    },
    get tab() {
      return tab!;
    },
    withTab() {
      tab = new FakeTab();
      return tab;
    },
  };
}

describe("BrowserAgent", () => {
  it("opens a page in the window and answers with where it landed", async () => {
    const t = setup();
    const result = await t.agent.open({ url: "https://reservas.example/taberna" });
    expect(t.windows).toBe(1);
    expect(t.opened).toEqual([{ url: "https://reservas.example/taberna", newTab: false }]);
    expect(t.events).toEqual([{ type: "browser.action", caption: "Opening reservas.example" }]);
    expect(result).toMatchObject({
      url: "https://reservas.example/taberna",
      title: "Taberna da Rua",
      change: "page changed",
    });
    expect(result.tabs).toHaveLength(1);
  });

  it("says when there's no page to act on", async () => {
    const t = setup();
    await expect(t.agent.snapshot({})).rejects.toThrow("No page is open; browser.open opens one.");
  });

  it("snapshots with refs, then a second look at the same page is “same page”", async () => {
    const t = setup();
    t.withTab();
    const first = await t.agent.snapshot({});
    expect(first.text).toContain("[7] button “Check availability”");
    expect(first.change).toBe("page changed");
    const second = await t.agent.snapshot({});
    expect(second.change).toBe("same page");
    expect(second.text).toBe(first.text);
  });

  it("clicks a ref: ring and caption first, for 600 ms, then the mouse at its centre", async () => {
    const t = setup();
    const tab = t.withTab();
    await t.agent.snapshot({});
    tab.onClick = () => (tab.page = { ...tab.page, print: "results" });
    const result = await t.agent.click({ ref: 7 });

    const rect = { x: 100, y: 200, width: 160, height: 40 };
    expect(t.events).toEqual([
      { type: "browser.action", caption: "Clicking ‘Check availability’", ref: 7, rect },
    ]);
    expect(t.waits).toContain(RING_MS);
    const isOverlay = (c: { params?: Record<string, unknown> }) =>
      String(c.params?.expression).includes("attachShadow");
    const overlay = tab.calls.findIndex(isOverlay);
    expect(String(tab.calls[overlay]?.params?.expression)).toContain("Clicking ‘Check availability’");
    // The overlay is drawn before the mouse moves.
    expect(overlay).toBeLessThan(tab.calls.findIndex((c) => c.method === "Input.dispatchMouseEvent"));
    expect(
      tab.called("Input.dispatchMouseEvent").map((c) => [c.params?.type, c.params?.x, c.params?.y]),
    ).toEqual([
      ["mouseMoved", 180, 220],
      ["mousePressed", 180, 220],
      ["mouseReleased", 180, 220],
    ]);
    expect(tab.called("DOM.scrollIntoViewIfNeeded")[0]?.params).toEqual({ backendNodeId: 121 });
    expect(result).toEqual({ url: tab.page.url, title: "Book a table", change: "page changed" });
  });

  it("refuses a ref the page doesn't have, or one whose element has gone", async () => {
    const t = setup();
    t.withTab();
    await expect(t.agent.click({ ref: 7 })).rejects.toThrow(
      "There's no [7] on this page; take a snapshot for the current refs.",
    );
    await t.agent.snapshot({});
    const refs = (t.agent as unknown as { refs: Map<string, { get(r: number): { backendNodeId: number } }> })
      .refs;
    refs.get("tab-1")!.get(7)!.backendNodeId = 999;
    await expect(t.agent.click({ ref: 7 })).rejects.toThrow(/\[7\] isn't on the page any more/);
  });

  it("forgets refs once the tab moves to a new document", async () => {
    const t = setup();
    const tab = t.withTab();
    await t.agent.snapshot({});
    tab.page = { ...tab.page, doc: 2 };
    await expect(t.agent.click({ ref: 7 })).rejects.toThrow(/There's no \[7\]/);
  });

  it("types over a field's text and submits with Enter", async () => {
    const t = setup();
    const tab = t.withTab();
    await t.agent.snapshot({});
    await t.agent.type({ ref: 4, text: "2026-10-24", submit: true });
    expect(t.events.at(-1)).toMatchObject({ caption: "Typing ‘2026-10-24’ into ‘Date’", ref: 4 });
    expect(tab.called("DOM.focus")[0]?.params).toEqual({ backendNodeId: 118 });
    expect(tab.called("Input.insertText")[0]?.params).toEqual({ text: "2026-10-24" });
    expect(tab.called("Input.dispatchKeyEvent").map((c) => [c.params?.type, c.params?.key])).toEqual([
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ]);
  });

  it("picks an option, and lists the options when it can't", async () => {
    const t = setup();
    const tab = t.withTab();
    await t.agent.snapshot({});
    await t.agent.select({ ref: 5, option: "6 people" });
    expect(t.events.at(-1)).toMatchObject({ caption: "Choosing ‘6 people’ in ‘Party size’", ref: 5 });
    tab.selectAnswer = { error: "no-option", options: ["2 people", "4 people"] };
    await expect(t.agent.select({ ref: 5, option: "12" })).rejects.toThrow(
      "[5] has no option “12”. It has: 2 people, 4 people.",
    );
    tab.selectAnswer = { error: "not-select" };
    await expect(t.agent.select({ ref: 5, option: "6" })).rejects.toThrow(/isn't a list of options/);
  });

  it("presses keys and scrolls", async () => {
    const t = setup();
    const tab = t.withTab();
    await t.agent.press({ key: "Escape" });
    expect(t.events.at(-1)).toEqual({ type: "browser.action", caption: "Pressing Escape" });
    await expect(t.agent.press({ key: "Hyper+x" })).rejects.toThrow(/isn't a modifier/);
    await t.agent.scroll({ direction: "down" });
    expect(tab.called("Input.dispatchMouseEvent").at(-1)?.params).toMatchObject({
      type: "mouseWheel",
      x: 600,
      y: 400,
      deltaY: 640,
    });
    await t.agent.scroll({ direction: "top" });
    expect(t.events.at(-1)?.type === "browser.action" && t.events.at(-1)).toMatchObject({
      caption: "Scrolling to the top",
    });
  });

  it("goes back only when there's a page to go back to", async () => {
    const t = setup();
    const tab = t.withTab();
    await expect(t.agent.navigate({ action: "back" })).rejects.toThrow("There's no page to go back to.");
    tab.history.back = true;
    const result = await t.agent.navigate({ action: "back" });
    expect(result).toMatchObject({ url: "https://reservas.example/", change: "page changed" });
  });

  it("waits for text up to 15 s, polling the page", async () => {
    const t = setup();
    const tab = t.withTab();
    tab.bodyText = "Your table for 4 is booked";
    await expect(t.agent.wait({ text: "table for 4" })).resolves.toMatchObject({ url: tab.page.url });
    tab.bodyText = "Loading";
    await expect(t.agent.wait({ text: "table for 4" })).rejects.toThrow(
      "“table for 4” didn't appear on the page within 15 s.",
    );
    t.waits.length = 0;
    await t.agent.wait({ ms: 1200 });
    expect(t.waits).toEqual([1200]);
  });

  it("screenshots the viewport as a JPEG under 300 KB and uploads it", async () => {
    const t = setup();
    const tab = t.withTab();
    const shot = await t.agent.screenshot();
    expect(tab.called("Page.captureScreenshot").map((c) => c.params?.quality)).toEqual([80, 60]);
    expect(shot).toMatchObject({
      upload: { id: "u1", name: "browser-2026-10-17-091200.jpg" },
      width: 1200,
      height: 800,
      url: tab.page.url,
    });
  });

  describe("take over", () => {
    it("refuses every action with “Matthew has the browser” until he hands back", async () => {
      const t = setup();
      t.withTab();
      t.agent.takeOver();
      expect(t.agent.control).toBe("matthew");
      expect(t.changes).toBe(1);
      for (const run of [
        () => t.agent.open({ url: "https://example.com/" }),
        () => t.agent.snapshot({}),
        () => t.agent.click({ ref: 1 }),
        () => t.agent.type({ ref: 1, text: "x" }),
        () => t.agent.press({ key: "Enter" }),
        () => t.agent.scroll({ direction: "down" }),
        () => t.agent.wait({ ms: 10 }),
        () => t.agent.screenshot(),
        () => t.agent.tabs({ action: "list" }),
        () => t.agent.navigate({ action: "reload" }),
      ])
        await expect(run()).rejects.toThrow(/^Matthew has the browser$/);
      expect(t.tab.calls).toEqual([]);
      expect(t.windows).toBe(0);
      // The status line isn't a page action: it still updates.
      await expect(t.agent.setStatus({ text: "Waiting for Matthew" })).resolves.toEqual({
        status: "Waiting for Matthew",
      });

      t.agent.handBack();
      expect(t.agent.control).toBe("jarvis");
      await expect(t.agent.snapshot({})).resolves.toMatchObject({ url: t.tab.page.url });
    });

    it("stops before touching the page when Matthew takes over during the ring", async () => {
      const t = setup();
      const tab = t.withTab();
      await t.agent.snapshot({});
      const agent = t.agent as unknown as { deps: { wait(ms: number): Promise<void> } };
      agent.deps.wait = async () => t.agent.takeOver();
      await expect(t.agent.click({ ref: 7 })).rejects.toThrow("Matthew has the browser");
      expect(tab.called("Input.dispatchMouseEvent")).toEqual([]);
    });

    it("goes back to the server as the rpc's error, word for word", async () => {
      const t = setup();
      t.agent.takeOver();
      const sent: unknown[] = [];
      const answer = await answerRpc(
        { type: "rpc", id: "r1", kind: "browser.snapshot", payload: {} },
        browserRpcHandlers(t.agent),
        async (_path, a) => void sent.push(a),
      );
      expect(answer).toEqual({ ok: false, error: "Matthew has the browser" });
      expect(sent).toEqual([answer]);
    });
  });
});

describe("browserRpcHandlers", () => {
  it("covers every browser.* kind and validates before acting", async () => {
    const t = setup();
    const handlers = browserRpcHandlers(t.agent);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        "browser.click",
        "browser.navigate",
        "browser.open",
        "browser.press",
        "browser.screenshot",
        "browser.scroll",
        "browser.select",
        "browser.snapshot",
        "browser.status",
        "browser.tabs",
        "browser.type",
        "browser.wait",
      ].sort(),
    );
    await expect(handlers["browser.open"]!({ url: "javascript:alert(1)" })).rejects.toThrow(
      "Only http and https pages open in the browser.",
    );
    await expect(handlers["browser.click"]!({ ref: "first" })).rejects.toThrow(/ref should be/);
    expect(t.opened).toEqual([]);
    await handlers["browser.open"]!({ url: "reservas.example/taberna", newTab: true });
    expect(t.opened).toEqual([{ url: "https://reservas.example/taberna", newTab: true }]);
  });
});

describe("fitScreenshot", () => {
  it("lowers quality, then scale, until it fits; gives up past the last step", async () => {
    const tried: string[] = [];
    const sizes = [900_000, 500_000, 350_000, 290_000];
    const fit = await fitScreenshot(async (q, s) => {
      tried.push(`${q}@${s}`);
      return new Uint8Array(sizes.shift()!);
    });
    expect(tried).toEqual(["80@1", "60@1", "45@1", "45@0.75"]);
    expect(fit.scale).toBe(0.75);
    await expect(fitScreenshot(async () => new Uint8Array(400_000))).rejects.toThrow(/300 KB/);
  });

  it("names screenshots by time", () => {
    expect(screenshotName(new Date(2026, 9, 17, 9, 5, 7))).toBe("browser-2026-10-17-090507.jpg");
  });
});

describe("BrowserAgent's risky-action guard (JD-60)", () => {
  /** The booking page with its button and date field renamed: a checkout. */
  function checkout(t: ReturnType<typeof setup>) {
    const tab = t.withTab();
    const nodes = bookingNodes().map((n) =>
      n.nodeId === "21"
        ? { ...n, name: { type: "string", value: "Place order" } }
        : n.nodeId === "18"
          ? { ...n, name: { type: "string", value: "Password" } }
          : n,
    );
    const send = tab.cdp.send;
    tab.cdp = {
      send: async <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
        method === "Accessibility.getFullAXTree" ? ({ nodes } as T) : send<T>(method, params),
    };
    return tab;
  }

  it("refuses ‘Place order’ in Normal mode before anything shows or moves", async () => {
    const t = setup();
    const tab = checkout(t);
    await t.agent.snapshot({});
    await expect(t.agent.click({ ref: 7, task: { taskId: "t1", mode: "normal" } })).rejects.toThrow(
      `${BROWSER_NEEDS_APPROVAL}: clicking ‘Place order’`,
    );
    expect(t.events).toEqual([]);
    expect(tab.called("Input.dispatchMouseEvent")).toEqual([]);
  });

  it("clicks it with Matthew's approval, or in Full autonomy", async () => {
    const t = setup();
    const tab = checkout(t);
    await t.agent.snapshot({});
    await t.agent.click({ ref: 7, task: { taskId: "t1", mode: "normal", approval: "appr-1" } });
    await t.agent.click({ ref: 7, task: { taskId: "t1", mode: "full" } });
    expect(tab.called("Input.dispatchMouseEvent")).toHaveLength(6);
  });

  it("never types into a password field, in either mode", async () => {
    const t = setup();
    const tab = checkout(t);
    await t.agent.snapshot({});
    for (const mode of ["normal", "full"] as const)
      await expect(
        t.agent.type({ ref: 4, text: "hunter2", task: { taskId: "t1", mode, approval: "appr-1" } }),
      ).rejects.toThrow(BROWSER_NEEDS_MATTHEW);
    expect(tab.called("Input.insertText")).toEqual([]);
  });

  it("the rpc carries the task's grant through to the guard", async () => {
    const t = setup();
    checkout(t);
    await t.agent.snapshot({});
    const handlers = browserRpcHandlers(t.agent);
    await expect(
      handlers["browser.click"]!({ ref: 7, task: { taskId: "t1", mode: "normal" } }),
    ).rejects.toThrow(BROWSER_NEEDS_APPROVAL);
    await expect(
      handlers["browser.click"]!({ ref: 7, task: { taskId: "t1", mode: "full" } }),
    ).resolves.toMatchObject({
      url: "https://reservas.example/taberna",
    });
    await expect(handlers["browser.click"]!({ ref: 7, task: { mode: "full" } })).rejects.toThrow(
      "task needs a taskId",
    );
  });
});

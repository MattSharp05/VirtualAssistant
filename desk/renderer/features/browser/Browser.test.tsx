import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserState, DeskBridge, DeskEvent } from "@jarvis/shared";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import BrowserWindow from "./index";
import { CAPTION_MS, displayAddress, FADE_MS, RING_MS, statusLine } from "./model";

let bridge: MockBridge;

function renderBrowser(scenario: string, preview = true) {
  bridge = createMockBridge(findScenario(scenario)!);
  render(
    <BridgeProvider value={preview ? { bridge, scenario } : { bridge }}>
      <BrowserWindow />
    </BridgeProvider>,
  );
}

const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  tabs: [],
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  control: "jarvis",
  ...over,
});

describe("Browser window", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
    vi.useRealTimers();
  });

  it("shows the tabs, the address, the task's status line and Take over", async () => {
    renderBrowser("browser-idle");
    const tabs = await screen.findByRole("navigation", { name: "Tabs" });
    expect(
      within(tabs)
        .getByRole("button", { name: /^Book a table · Taberna da Rua/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(tabs)
        .getByRole("button", { name: /^Alfama, Lisbon/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "reservas.example/taberna-da-rua",
    );
    expect(screen.getByRole("status", { name: "Status" }).textContent).toBe(
      "JARVISBooking a table for 4 · Friday 23 October, 20:00",
    );
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Take over" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { name: "Book a table" })).toBeTruthy();
  });

  it("Take over and Hand back go to main, and the window follows its state", async () => {
    renderBrowser("browser-idle");
    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    const back = await screen.findByRole("button", { name: "Hand back" });
    expect(back.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status", { name: "Status" }).textContent).toContain("You have the browser");
    fireEvent.click(back);
    await screen.findByRole("button", { name: "Take over" });
    expect(bridge.browser.commands).toEqual([{ type: "take-over" }, { type: "hand-back" }]);
  });

  it("the address bar, toolbar and tab strip send Matthew's commands", async () => {
    renderBrowser("browser-idle");
    const address = (await screen.findByLabelText("Address")) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "example.com/menu" } });
    fireEvent.submit(address.closest("form")!);
    await screen.findByDisplayValue("example.com/menu");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: /^Alfama, Lisbon/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close tab Alfama, Lisbon · Maps" }));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(bridge.browser.commands).toEqual([
      { type: "go", address: "example.com/menu" },
      { type: "back" },
      { type: "reload" },
      { type: "switch-tab", tabId: "tab-2" },
      { type: "close-tab", tabId: "tab-2" },
      { type: "new-tab" },
    ]);
  });

  it("Escape in the address bar puts the page's address back", async () => {
    renderBrowser("browser-idle");
    const address = (await screen.findByLabelText("Address")) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "half typed" } });
    fireEvent.keyDown(address, { key: "Escape" });
    expect(address.value).toBe("reservas.example/taberna-da-rua");
  });

  it("rings the element for 600 ms and fades the caption after", async () => {
    vi.useFakeTimers();
    // A bridge to publish on as main would.
    const fns = new Set<(e: DeskEvent) => void>();
    bridge = createMockBridge(findScenario("browser-idle")!);
    const own: DeskBridge = {
      ...bridge,
      subscribe: (fn) => {
        fns.add(fn);
        return () => fns.delete(fn);
      },
    };
    render(
      <BridgeProvider value={{ bridge: own, scenario: "browser-idle" }}>
        <BrowserWindow />
      </BridgeProvider>,
    );
    await act(async () => {});
    expect(screen.queryByTestId("browser-ring")).toBeNull();
    act(() =>
      fns.forEach((fn) => fn({ type: "browser.action", caption: "Clicking ‘Check availability’", ref: 14 })),
    );
    expect(screen.getByTestId("browser-ring")).toBeTruthy();
    expect(screen.getByText("Clicking ‘Check availability’")).toBeTruthy();
    act(() => vi.advanceTimersByTime(RING_MS));
    expect(screen.queryByTestId("browser-ring")).toBeNull();
    expect(
      screen.getByText("Clicking ‘Check availability’").closest(".browser-act")!.hasAttribute("data-fading"),
    ).toBe(false);
    act(() => vi.advanceTimersByTime(CAPTION_MS - RING_MS));
    expect(
      screen.getByText("Clicking ‘Check availability’").closest(".browser-act")!.hasAttribute("data-fading"),
    ).toBe(true);
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(screen.queryByText("Clicking ‘Check availability’")).toBeNull();
  });

  it("in the app, lays the page over its slot and hides it when no tab is left", async () => {
    renderBrowser("browser-idle", false);
    const show = vi.spyOn(bridge.browser, "show");
    const hide = vi.spyOn(bridge.browser, "hide");
    await screen.findByRole("region", { name: "Page" });
    // The slot was measured before the spies: re-measure on a resize.
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(show).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    expect(screen.queryByRole("heading", { name: "Book a table" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close tab Alfama, Lisbon · Maps" }));
    fireEvent.click(screen.getByRole("button", { name: "Close tab Book a table · Taberna da Rua" }));
    await screen.findByRole("heading", { name: "No page open" });
    expect(hide).toHaveBeenCalled();
  });

  it("with no tabs, says what the window is for", async () => {
    renderBrowser("empty");
    await screen.findByRole("heading", { name: "No page open" });
    expect(screen.getByRole("status", { name: "Status" }).textContent).toContain("Ready when you ask");
  });
});

describe("browser model", () => {
  it("status line: Matthew first, then the task, then loading", () => {
    expect(statusLine(state({ control: "matthew", status: "Booking" })).who).toBe("You");
    expect(statusLine(state({ status: "Booking", loading: true }))).toEqual({
      who: "JARVIS",
      text: "Booking",
    });
    expect(statusLine(state({ loading: true })).text).toBe("Loading…");
    expect(statusLine(state({ tabs: [{ id: "t", url: "", title: "", active: true }] })).text).toBe("Ready");
  });

  it("address: no https://, no bare trailing slash, nothing for a blank tab", () => {
    expect(displayAddress("https://example.com/")).toBe("example.com");
    expect(displayAddress("https://example.com/a/")).toBe("example.com/a/");
    expect(displayAddress("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(displayAddress("about:blank")).toBe("");
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskBridge } from "@jarvis/shared";
import { createMockBridge, type MockBridge } from "../mock/bridge";
import { findScenario } from "../mock/scenarios";
import { BridgeProvider } from "./bridge";
import { FullView } from "./FullView";

let bridge: MockBridge;

function renderFullView(webview?: DeskBridge["webview"], url = "https://claude.ai/code/session_01MK") {
  bridge = createMockBridge(findScenario("empty")!);
  if (webview) bridge.webview = webview;
  return render(
    <BridgeProvider value={{ bridge }}>
      <FullView url={url} site="claude.ai" name="mk" />
    </BridgeProvider>,
  );
}

describe("FullView", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("in the web preview, shows the placeholder card with a link to the site", () => {
    renderFullView();
    expect(screen.getByRole("heading", { name: "Full view works in the app" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open “mk” on claude.ai" }).getAttribute("href")).toBe(
      "https://claude.ai/code/session_01MK",
    );
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("in the app, asks main to show the url over its slot, and hides it when it goes", () => {
    const webview = { show: vi.fn(), hide: vi.fn() };
    const view = renderFullView(webview);
    expect(screen.getByRole("region", { name: "mk on claude.ai" })).toBeTruthy();
    expect(webview.show).toHaveBeenCalledWith("https://claude.ai/code/session_01MK", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(webview.hide).not.toHaveBeenCalled();
    view.unmount();
    expect(webview.hide).toHaveBeenCalledTimes(1);
  });

  it("a new url hides nothing for long: it shows the new page", () => {
    const webview = { show: vi.fn(), hide: vi.fn() };
    const view = renderFullView(webview);
    view.rerender(
      <BridgeProvider value={{ bridge }}>
        <FullView url="https://claude.ai/code/session_01TR" site="claude.ai" name="trip" />
      </BridgeProvider>,
    );
    expect(webview.show).toHaveBeenLastCalledWith("https://claude.ai/code/session_01TR", expect.anything());
  });

  it("shows the sign-in hint on first use only", () => {
    renderFullView({ show: vi.fn(), hide: vi.fn() });
    expect(screen.getByRole("note").textContent).toContain(
      "Sign in once here; use email sign-in (Google sign-in may be blocked inside apps).",
    );
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    bridge.close();
    renderFullView({ show: vi.fn(), hide: vi.fn() });
    expect(screen.queryByRole("note")).toBeNull();
  });
});

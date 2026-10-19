import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskBridge, FullViewSignIn } from "@jarvis/shared";
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
    expect(screen.getByRole("note").textContent).toContain("Sign in once here and it stays signed in;");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    bridge.close();
    renderFullView({ show: vi.fn(), hide: vi.fn() });
    expect(screen.queryByRole("note")).toBeNull();
  });

  describe("signing in (JD-68)", () => {
    function appWebview() {
      let report: (state: FullViewSignIn) => void = () => {};
      const webview = {
        show: vi.fn(),
        hide: vi.fn(),
        openLink: vi.fn(),
        onSignIn: vi.fn((fn: (state: FullViewSignIn) => void) => {
          report = fn;
          return () => {};
        }),
      };
      return { webview, report: (state: FullViewSignIn) => act(() => report(state)) };
    }

    it("Sign in with a link opens a pasted claude.ai link in the full view", () => {
      const { webview } = appWebview();
      renderFullView(webview);
      expect(screen.getByRole("note").textContent).toContain("don't click it, it opens your browser");
      fireEvent.click(screen.getByRole("button", { name: "Sign in with a link" }));
      const input = screen.getByRole("textbox", { name: "Sign-in link from the email" });
      fireEvent.change(input, { target: { value: "  https://claude.ai/magic-link#abc:ZW1haWw= " } });
      fireEvent.click(screen.getByRole("button", { name: "Open link" }));
      expect(webview.openLink).toHaveBeenCalledWith("https://claude.ai/magic-link#abc:ZW1haWw=");
      expect(screen.queryByRole("textbox")).toBeNull();
      // The page the window asked for is unchanged: the link loads over it, in main.
      expect(webview.show).not.toHaveBeenCalledWith(expect.stringContaining("magic-link"), expect.anything());
    });

    it("refuses anything but an https claude.ai or Notion link, and says why", () => {
      const { webview } = appWebview();
      renderFullView(webview);
      fireEvent.click(screen.getByRole("button", { name: "Sign in with a link" }));
      const input = screen.getByRole("textbox", { name: "Sign-in link from the email" });
      for (const value of ["123456", "http://claude.ai/magic-link#abc", "https://evil.example/claude.ai"]) {
        fireEvent.change(input, { target: { value } });
        fireEvent.submit(input.closest("form")!);
        expect(screen.getByRole("alert").textContent).toContain("Paste the whole link from the email");
        expect(input.getAttribute("aria-invalid")).toBe("true");
      }
      expect(webview.openLink).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("the hint comes back on a sign-in page, and says to use the email link when Google refuses", () => {
      localStorage.setItem("jarvis.fullViewHintSeen", "1");
      const { webview, report } = appWebview();
      renderFullView(webview);
      expect(screen.queryByRole("note")).toBeNull();
      report({ signInPage: false, googleBlocked: false });
      expect(screen.queryByRole("note")).toBeNull();
      report({ signInPage: true, googleBlocked: false });
      expect(screen.getByRole("button", { name: "Sign in with a link" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Got it" }));
      // The same state again (main repeats it on every move) doesn't bring it back...
      report({ signInPage: true, googleBlocked: false });
      expect(screen.queryByRole("note")).toBeNull();
      // ...Google refusing does.
      report({ signInPage: true, googleBlocked: true });
      expect(screen.getByRole("note").textContent).toContain(
        "Google won't sign in inside the app: use email sign-in instead.",
      );
    });
  });
});

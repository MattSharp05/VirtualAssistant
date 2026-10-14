import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskBridge } from "@jarvis/shared";
import { App } from "./App";
import { BridgeProvider, chooseBridge } from "./bridge";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the placeholder when no window matches", () => {
    window.location.hash = "#/nothing";
    render(
      <BridgeProvider value={chooseBridge("?scenario=empty", undefined)}>
        <App />
      </BridgeProvider>,
    );
    expect(screen.getByRole("heading", { name: "JARVIS Desk" })).toBeTruthy();
  });

  it("shows the preview scenario and the events it replays", () => {
    vi.useFakeTimers();
    render(
      <BridgeProvider value={chooseBridge("?scenario=demo-day&window=home", undefined)}>
        <App />
      </BridgeProvider>,
    );
    expect(screen.getByTestId("scenario").textContent).toContain("demo-day");
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("scenario").textContent).toContain("notice: mk merged MK-74");
  });
});

describe("chooseBridge", () => {
  const native = { subscribe: () => () => {} } as unknown as DeskBridge;

  it("uses Electron's bridge unless a scenario is asked for", () => {
    expect(chooseBridge("", native)).toEqual({ bridge: native });
    expect(chooseBridge("?scenario=empty", native).scenario).toBe("empty");
  });

  it("falls back to demo-day in a plain browser and to empty for unknown names", () => {
    expect(chooseBridge("", undefined).scenario).toBe("demo-day");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(chooseBridge("?scenario=nope", undefined).scenario).toBe("empty");
  });
});

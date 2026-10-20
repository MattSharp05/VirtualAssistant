import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { Overlay } from "./Overlay";
import { SHRINK_AFTER_MS } from "./useOrb";

function renderOn(scenario: string) {
  const choice = chooseBridge(`?scenario=${scenario}`, undefined);
  render(
    <BridgeProvider value={choice}>
      <Overlay />
    </BridgeProvider>,
  );
  return { orb: () => screen.getByRole("button", { name: /JARVIS/ }), bridge: choice.bridge as MockBridge };
}

describe("Overlay + orb", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows each scenario's state and mood", async () => {
    vi.useFakeTimers();
    for (const [scenario, state, mood] of [
      ["orb-idle", "idle", "green"],
      ["orb-listening", "listening", "green"],
      ["orb-thinking", "thinking", "green"],
      ["orb-speaking", "speaking", "green"],
      ["orb-mood-red", "idle", "red"],
    ]) {
      const { orb } = renderOn(scenario);
      await act(async () => void vi.advanceTimersByTime(200));
      expect(orb().dataset.orbState, scenario).toBe(state);
      expect(orb().dataset.orbMood, scenario).toBe(mood);
      cleanup();
    }
  });

  it("grows when active and shrinks back 10 s after going idle", async () => {
    vi.useFakeTimers();
    const { orb } = renderOn("orb-cycle");
    expect(orb().dataset.orbExpanded).toBe("false");
    await act(async () => void vi.advanceTimersByTime(400));
    expect(orb().dataset.orbState).toBe("listening");
    expect(orb().dataset.orbExpanded).toBe("true");
    const seen = new Set<string>();
    for (let t = 0; t < 8000; t += 100) {
      await act(async () => void vi.advanceTimersByTime(100));
      seen.add(orb().dataset.orbState!);
    }
    expect([...seen].sort()).toEqual(["idle", "listening", "speaking", "thinking"]);
  });

  it("reports hover for click-through and clicks to the bridge", () => {
    const { orb, bridge } = renderOn("orb-idle");
    expect(bridge.interactive).toBe(false);
    fireEvent.mouseEnter(orb());
    expect(bridge.interactive).toBe(true);
    fireEvent.mouseLeave(orb());
    expect(bridge.interactive).toBe(false);
  });

  it("right-click or control-click asks main for the orb's menu, not the ring (JD-62)", () => {
    const { orb, bridge } = renderOn("orb-idle");
    fireEvent.contextMenu(orb());
    expect(bridge.appActions).toEqual(["orb-menu"]);
    fireEvent.click(orb(), { ctrlKey: true });
    expect(bridge.orbClicks).toBe(0);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("opens the launcher ring on click; Esc, a click elsewhere or the orb close it", () => {
    const { orb, bridge } = renderOn("orb-idle");
    const ring = () => screen.queryAllByRole("button").filter((b) => b.dataset.launcherId);
    fireEvent.click(orb());
    expect(bridge.orbClicks).toBe(1);
    expect(ring().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Chat",
      "Sessions",
      "Agents",
      "Today",
      "Calendar",
      "To-do",
      "Ideas",
      "Notion",
      "System",
    ]);
    // The whole overlay takes clicks while the ring is open, so "elsewhere" can close it.
    expect(bridge.interactive).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ring()).toHaveLength(0);
    expect(bridge.interactive).toBe(false);

    fireEvent.click(orb());
    fireEvent.click(screen.getByTestId("launcher-backdrop"));
    expect(ring()).toHaveLength(0);
    fireEvent.click(orb());
    fireEvent.click(orb());
    expect(ring()).toHaveLength(0);
  });

  it("opens a window from the ring (Chat exists since JD-29)", () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { orb, bridge } = renderOn("orb-idle");
    fireEvent.click(orb());
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(bridge.opened).toEqual(["chat"]);
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });

  it("starts with the ring open in the launcher-open scenario", () => {
    renderOn("launcher-open");
    expect(screen.getByRole("navigation", { name: "Open a window" })).toBeTruthy();
  });

  it("stays large for 10 s after going idle, then shrinks to the dot", async () => {
    vi.useFakeTimers();
    const bridge = createMockBridge({
      name: "t",
      description: "",
      data: {},
      events: [
        { after: 100, event: { type: "orb.state", state: "thinking" } },
        { after: 100, event: { type: "orb.state", state: "idle" } },
      ],
    });
    render(
      <BridgeProvider value={{ bridge, scenario: "t" }}>
        <Overlay />
      </BridgeProvider>,
    );
    const orb = () => screen.getByRole("button", { name: /JARVIS/ });
    await act(async () => void vi.advanceTimersByTime(250));
    expect(orb().dataset.orbState).toBe("idle");
    expect(orb().dataset.orbExpanded).toBe("true");
    await act(async () => void vi.advanceTimersByTime(SHRINK_AFTER_MS - 100));
    expect(orb().dataset.orbExpanded).toBe("true");
    await act(async () => void vi.advanceTimersByTime(200));
    expect(orb().dataset.orbExpanded).toBe("false");
  });
});

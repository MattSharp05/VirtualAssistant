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
    fireEvent.click(orb());
    expect(bridge.orbClicks).toBe(1);
    fireEvent.mouseLeave(orb());
    expect(bridge.interactive).toBe(false);
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

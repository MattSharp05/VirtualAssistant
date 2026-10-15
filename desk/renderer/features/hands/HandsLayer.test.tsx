import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import { HandsLayer } from "./HandsLayer";
import type { TrackerCallbacks } from "./tracker";

/** A fake camera loop: the test feeds frames through `cb`. */
function fakeTracker() {
  const t = {
    cb: undefined as TrackerCallbacks | undefined,
    stop: vi.fn(),
    start: vi.fn((cb: TrackerCallbacks) => {
      t.cb = cb;
      cb.onState?.("tracking");
      return { stop: t.stop };
    }),
  };
  return t;
}

const flush = () => act(async () => {});

describe("HandsLayer", () => {
  afterEach(cleanup);

  it("stays off (no camera) while Camera hands is off", async () => {
    const tracker = fakeTracker();
    const bridge = createMockBridge(findScenario("empty")!);
    const { container } = render(<HandsLayer bridge={bridge} track={tracker.start} />);
    await flush();
    expect(tracker.start).not.toHaveBeenCalled();
    expect(container.querySelector(".hands-layer")).toBeNull();
  });

  it("draws a ring and a dot per hand, and stops the camera when turned off", async () => {
    const tracker = fakeTracker();
    const bridge = createMockBridge(findScenario("hands-on")!);
    const { container } = render(<HandsLayer bridge={bridge} track={tracker.start} />);
    await flush();
    expect(tracker.start).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-hands-state=tracking]")).not.toBeNull();

    act(() =>
      tracker.cb!.onFrame([{ hand: "Left", index: { x: 0.5, y: 0.5 }, thumb: { x: 0.5, y: 0.6 } }], 0),
    );
    const ring = container.querySelector<HTMLElement>("[data-hand=Left] .hand-ring")!;
    expect(ring.style.transform).toBe(`translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`);
    expect(container.querySelector("[data-hand=Left] .hand-dot")).not.toBeNull();

    act(() => tracker.cb!.onFrame([], 600));
    expect(container.querySelector("[data-hand=Left]")!.classList).toContain("hand-faded");

    // The tray toggle: main sets the setting and tells the overlay it changed.
    await act(() => bridge.settings.set("cameraHands", false));
    await flush();
    expect(tracker.stop).toHaveBeenCalled();
    expect(container.querySelector(".hands-layer")).toBeNull();

    await act(() => bridge.settings.set("cameraHands", true));
    await flush();
    expect(tracker.start).toHaveBeenCalledTimes(2);
  });
});

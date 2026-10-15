import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import System from "./index";
import { REFRESH_MS } from "./useSystem";

let bridge: MockBridge;

function renderSystem(scenario: string) {
  bridge = createMockBridge(findScenario(scenario)!);
  render(
    <BridgeProvider value={{ bridge, scenario }}>
      <System />
    </BridgeProvider>,
  );
}

const meter = (name: string) => screen.getByRole("meter", { name });
const level = (name: string) => meter(name).closest(".system-meter")!.getAttribute("data-level");

describe("System window", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
    vi.useRealTimers();
  });

  it("shows the scenario's plan, fires and memory with their colours", async () => {
    renderSystem("system");
    await screen.findByRole("heading", { name: "CLAUDE PLAN" });
    expect(meter("5-hour window").getAttribute("aria-valuenow")).toBe("75");
    expect(level("5-hour window")).toBe("amber");
    expect(meter("Weekly").getAttribute("aria-valuenow")).toBe("92");
    expect(level("Weekly")).toBe("red");
    expect(screen.getByText("resets in 2 h 10 min")).toBeTruthy();
    expect(screen.getByText("24 / 30")).toBeTruthy();
    expect(level("New cloud jobs")).toBe("amber");
    expect(screen.getByText("412 MB of 1.0 GB")).toBeTruthy();
    expect(level("Memory")).toBe("ok");
    expect(screen.getByRole("img", { name: /^Memory over the last hour/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Worker 31% of today's tokens, chat 69%" })).toBeTruthy();
    expect(screen.getByRole("row", { name: /^Worker 188k 9 22 4 min 31%$/ })).toBeTruthy();
    expect(screen.getByText("Matthew's MacBook Pro")).toBeTruthy();
    expect(screen.getByText("seen 1 min ago")).toBeTruthy();
  });

  it("says what's missing when the server has no limits, history or devices", async () => {
    renderSystem("system-quiet");
    await screen.findByText("This login doesn't report plan limits.");
    expect(meter("5-hour window").getAttribute("aria-valuenow")).toBeNull();
    expect(screen.getByText("No routine set up (ROUTINE_ID)")).toBeTruthy();
    expect(screen.getByText("no limit set · peak 190 MB")).toBeTruthy();
    expect(screen.getByText("History builds up while JARVIS runs.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "No brain use yet today" })).toBeTruthy();
    expect(screen.getByText("No Macs paired.")).toBeTruthy();
  });

  it("shows voice latency against the target and where the time goes (JD-48)", async () => {
    renderSystem("system");
    const panel = (await screen.findByRole("heading", { name: "VOICE · FIRST WORD" })).closest("section")!;
    const stat = (label: string) => within(panel).getByText(label).closest(".latency-stat")!;
    expect(stat("Median (p50)").textContent).toBe("Median (p50)2.2 starget ≤ 2.5 s · met");
    expect(stat("p90").getAttribute("data-verdict")).toBe("met");
    expect(within(panel).getByText("last 20 turns")).toBeTruthy();
    expect(
      within(panel).getByRole("img", {
        name: "Where the time goes: Silence wait 704 ms, Whisper 356 ms, Request 50 ms, Brain 720 ms, First sentence 75 ms, say 310 ms, Playback 25 ms",
      }),
    ).toBeTruthy();
    expect(panel.textContent).toContain("Biggest: Brain (720 ms).");
    expect(panel.textContent).toContain("Last turn: 2.2 s · wake word · sonnet.");
  });

  it("says when the target is missed, and when nothing has been timed yet", async () => {
    renderSystem("system-latency-slow");
    const panel = (await screen.findByRole("heading", { name: "VOICE · FIRST WORD" })).closest("section")!;
    expect(panel.querySelectorAll('[data-verdict="missed"]')).toHaveLength(2);
    expect(panel.textContent).toContain("target ≤ 3.5 s · missed");
    expect(panel.textContent).toContain("Biggest: Brain (1.7 s).");
    expect(panel.textContent).toContain("Last turn: no first word · push-to-talk · sonnet.");
    cleanup();
    bridge.close();
    renderSystem("system-quiet");
    await screen.findByText(/No voice turns timed yet/);
    expect(screen.queryByText(/Median/)).toBeNull();
  });

  it("shows loading until the first answer", () => {
    renderSystem("system-loading");
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("refreshes every 15 s while open, and on Refresh now", async () => {
    vi.useFakeTimers();
    renderSystem("system");
    await act(async () => {});
    const gets = () => bridge.requests.filter((r) => r.path === "/system").length;
    expect(gets()).toBe(1);
    await act(async () => void vi.advanceTimersByTime(REFRESH_MS));
    expect(gets()).toBe(2);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Refresh now" })));
    expect(gets()).toBe(3);
  });

  it("keeps the last numbers when a refresh fails", async () => {
    vi.useFakeTimers();
    renderSystem("system");
    await act(async () => {});
    const request = vi.spyOn(bridge, "request").mockRejectedValue(new Error("server unreachable"));
    await act(async () => void vi.advanceTimersByTime(REFRESH_MS));
    expect(request).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/showing the last numbers.*server unreachable/);
    expect(meter("Weekly").getAttribute("aria-valuenow")).toBe("92");
  });
});

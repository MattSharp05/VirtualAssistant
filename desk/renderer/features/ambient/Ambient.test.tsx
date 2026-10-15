import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent } from "@jarvis/shared";
import { BridgeProvider, chooseBridge, type BridgeChoice } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import Ambient from "./index";
import { REFRESH_MS } from "./useAmbient";

function renderOn(scenario: string) {
  const choice: BridgeChoice = chooseBridge(`?scenario=${scenario}`, undefined);
  render(
    <BridgeProvider value={choice}>
      <Ambient />
    </BridgeProvider>,
  );
  return choice.bridge as MockBridge;
}

/** The ambient scenario with these events replayed 10 ms apart. */
function renderWithEvents(events: DeskEvent[]) {
  const scenario = findScenario("ambient")!;
  const bridge = createMockBridge({ ...scenario, events: events.map((event) => ({ after: 10, event })) });
  render(
    <BridgeProvider value={{ bridge, scenario: scenario.name, ui: scenario.ui! }}>
      <Ambient />
    </BridgeProvider>,
  );
  return bridge;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("Ambient face", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the scenario's clock, next event, to-dos, sessions and plan", async () => {
    renderOn("ambient");
    await screen.findByText(/^Standup · \d\d:30$/);
    // The scenario starts the clock at 09:00 (London): Standup is half an hour away.
    expect(text("ambient-next")).toContain("in 30 min");
    expect(text("ambient-todo")).toContain("2 open");
    await screen.findByText("Waiting on you");
    expect(text("ambient-sessions")).toBe("SessionsWorking2Waiting on you1Blocked1");
    expect(screen.getByRole("meter", { name: "5-hour plan usage" }).getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("meter", { name: "Weekly plan usage" }).getAttribute("aria-valuenow")).toBe("18");
    expect(text("ambient-plan")).toContain("5-hour · 42%");
    expect(text("ambient-report")).toMatch(/^Last report · mk-80-builder · \d+ min ago · MK-80/);
    expect(screen.getByRole("button", { name: "JARVIS (idle)" })).toBeTruthy();
  });

  it("follows the orb's state and mood, and stays large", async () => {
    renderWithEvents([
      { type: "orb.state", state: "listening" },
      { type: "mood.changed", mood: "amber", reason: "trip waits on you" },
      { type: "orb.state", state: "speaking", amplitude: 0.6 },
    ]);
    await screen.findByRole("button", { name: "JARVIS (speaking)" });
    const orb = document.querySelector(".orb")!;
    expect(orb.getAttribute("data-orb-mood")).toBe("amber");
    expect(orb.getAttribute("data-orb-expanded")).toBe("true");
    expect(text("ambient-state")).toBe("Speaking");
    expect(document.querySelector(".ambient-orb")?.getAttribute("data-orb-state")).toBe("speaking");
  });

  it("starts with the server's mood", async () => {
    renderOn("ambient");
    await settle();
    expect(document.querySelector(".orb")?.getAttribute("data-orb-mood")).toBe("red");
  });

  it("re-reads what changed: sessions, the digest, and to-dos live once one changes", async () => {
    const bridge = renderWithEvents([
      { type: "sessions.changed" },
      { type: "today.updated", generatedAt: "2026-10-14T09:00:00Z" },
      { type: "tasks.changed" },
    ]);
    const count = (path: string) => bridge.requests.filter((r) => r.path === path).length;
    await vi.waitFor(() => expect(count("/tasks?view=today")).toBe(1));
    expect([count("/today"), count("/sessions"), count("/usage")]).toEqual([2, 2, 1]);
    expect(text("ambient-todo")).toContain("2 open");
  });

  it("closes on Esc and on its close button; the orb opens Chat", async () => {
    const bridge = renderOn("ambient");
    await settle();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close ambient face" }));
    expect(bridge.frameActions).toEqual(["close", "close"]);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: "JARVIS (idle)" }));
    expect(bridge.opened).toEqual(["chat"]);
    open.mockRestore();
  });

  it("shows a quiet day and an unavailable plan", async () => {
    renderOn("ambient-quiet");
    await screen.findByText("Nothing else today");
    expect(text("ambient-todo")).toContain("0 open");
    expect(text("ambient-sessions")).toBe("SessionsWorking0Waiting on you0Blocked0");
    expect(text("ambient-plan")).toContain("Plan usage unavailable · not signed in to claude.ai");
    expect(text("ambient-report")).toBe("No reports yet");
  });

  it("re-reads everything every minute and on change events", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const bridge = renderOn("ambient");
    await settle();
    const count = (path: string) => bridge.requests.filter((r) => r.path === path).length;
    expect([count("/today"), count("/sessions"), count("/usage")]).toEqual([1, 1, 1]);
    act(() => void vi.advanceTimersByTime(REFRESH_MS));
    await settle();
    expect([count("/today"), count("/sessions"), count("/usage")]).toEqual([2, 2, 2]);
    expect(count("/tasks?view=today")).toBe(0);
  });
});

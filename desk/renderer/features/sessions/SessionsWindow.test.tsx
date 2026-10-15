import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { DeskEvent } from "@jarvis/shared";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import SessionsWindow from "./index";

function renderOn(scenario: string, hash = "") {
  window.location.hash = hash;
  const choice = chooseBridge(`?scenario=${scenario}`, undefined);
  render(
    <BridgeProvider value={choice}>
      <SessionsWindow />
    </BridgeProvider>,
  );
  return choice.bridge as MockBridge;
}

const groupTitles = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("Sessions window", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("shows the three groups and selects the first session that needs you", async () => {
    renderOn("sessions");
    expect(await screen.findByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(groupTitles()).toEqual(["Needs you", "Working", "Idle", "mk"]);
    expect(await screen.findByText("Blocked · needs you", { selector: ".sessions-pill" })).toBeTruthy();
    expect(await screen.findByText(/drift boost at 1.5×/)).toBeTruthy();
  });

  it("selects the session named in the window params, and follows a later change", async () => {
    renderOn("sessions", "#/sessions?id=trip");
    expect(await screen.findByRole("heading", { level: 2, name: "trip" })).toBeTruthy();
    expect(await screen.findByText(/Batch 3 done\. Handing/)).toBeTruthy();
    await act(async () => {
      window.location.hash = "#/sessions?id=notes-cleanup";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("heading", { level: 2, name: "notes-cleanup" })).toBeTruthy();
    expect(await screen.findByText(/Live activity isn't available/)).toBeTruthy();
  });

  it("filters the list", async () => {
    renderOn("sessions");
    await screen.findByRole("heading", { name: "Needs you" });
    fireEvent.change(screen.getByLabelText("Filter sessions"), { target: { value: "shapemint" } });
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    expect(within(nav).getAllByRole("button", { name: /ShapeMint/ })).toHaveLength(1);
    expect(within(nav).queryByRole("heading", { name: "Needs you" })).toBeNull();
  });

  it("sends a message through the bridge and says where it went", async () => {
    const bridge = renderOn("sessions");
    const input = await screen.findByLabelText("Message mk");
    fireEvent.change(input, { target: { value: "Go with (a)" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send to mk" })));
    expect(await screen.findByText("Sent to mk")).toBeTruthy();
    expect(bridge.requests.at(-1)).toEqual({ path: "/sessions/mk/send", body: { text: "Go with (a)" } });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("re-fetches the list on sessions.changed", async () => {
    const mock = createMockBridge(findScenario("sessions")!);
    const listeners: ((e: DeskEvent) => void)[] = [];
    const bridge = {
      ...mock,
      subscribe: (fn: (e: DeskEvent) => void) => (listeners.push(fn), () => undefined),
    };
    render(
      <BridgeProvider value={{ bridge, scenario: "sessions" }}>
        <SessionsWindow />
      </BridgeProvider>,
    );
    await screen.findByRole("heading", { name: "Needs you" });
    const lists = () => mock.requests.filter((r) => r.path === "/sessions").length;
    const before = lists();
    await act(async () => listeners.forEach((fn) => fn({ type: "sessions.changed" })));
    expect(lists()).toBe(before + 1);
  });

  it("empty: explains where sessions come from", async () => {
    renderOn("sessions-empty");
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
  });
});

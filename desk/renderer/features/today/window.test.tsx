import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent, TodayResponse } from "@jarvis/shared";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import type { Scenario } from "../../mock/types";
import Today from "./index";
import { BRIEF_SENT_MS } from "./useToday";

function renderWith(bridge: MockBridge) {
  render(
    <BridgeProvider value={{ bridge }}>
      <Today />
    </BridgeProvider>,
  );
  return bridge;
}

const renderOn = (scenario: string) =>
  renderWith(chooseBridge(`?scenario=${scenario}`, undefined).bridge as MockBridge);

const section = (id: string) => document.querySelector<HTMLElement>(`[data-section="${id}"]`)!;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("Today window", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("renders every section from the digest, next-up highlighted", async () => {
    renderOn("today");
    await screen.findByText("Lunch with Sam");
    for (const id of ["calendar", "inbox", "slack", "todo", "sessions"]) expect(section(id)).toBeTruthy();
    const next = document.querySelector("[data-next-up]")!;
    expect(next.textContent).toContain("Lunch with Sam");
    expect(next.textContent).toContain("Next up · in 2 h 30 min · Dishoom");
    expect(within(section("inbox")).getByText("+ 14 others JARVIS skipped")).toBeTruthy();
    expect(within(section("sessions")).getByText(/hotel budget cap/)).toBeTruthy();
    // Links leave for the browser.
    const standup = screen.getByRole("link", { name: "Standup" });
    expect(standup.getAttribute("target")).toBe("_blank");
    expect(screen.queryByTestId("today-stale")).toBeNull();
  });

  it("ticks and unticks a to-do through the bridge", async () => {
    const bridge = renderOn("today");
    const box = await screen.findByRole("checkbox", { name: /Answer trip: hotel budget/ });
    fireEvent.click(box);
    await settle();
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await settle();
    expect(bridge.requests.filter((r) => r.path.startsWith("/tasks/"))).toEqual([
      { path: "/tasks/t1/done", body: {} },
      { path: "/tasks/t1/reopen", body: {} },
    ]);
  });

  it("puts a to-do back when the server refuses", async () => {
    const base = findScenario("today")!;
    const data = { ...base.data };
    delete data["/tasks/t2/done"];
    renderWith(createMockBridge({ ...base, data }));
    const box = await screen.findByRole("checkbox", { name: /Review onboarding copy/ });
    fireEvent.click(box);
    await settle();
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't update/);
  });

  it("pops sections out into the right windows", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bridge = renderOn("today");
    await screen.findByText("Lunch with Sam");
    for (const name of [
      "Pop out calendar",
      "Pop out inbox",
      "Pop out Slack",
      "Open to-do window",
      "Open sessions window",
    ])
      fireEvent.click(screen.getByRole("button", { name }));
    expect(bridge.opened).toEqual([
      "calendar",
      "today?section=inbox",
      "today?section=slack",
      "todo",
      "sessions",
    ]);
    open.mockRestore();
  });

  it("shows one section alone in a section window", async () => {
    window.history.replaceState(null, "", "/?window=today&section=slack");
    renderOn("today");
    await screen.findByText("Can you review the onboarding copy today?");
    expect(section("slack")).toBeTruthy();
    expect(section("calendar")).toBeNull();
    expect(screen.queryByRole("button", { name: /Pop out/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Play morning brief" })).toBeNull();
  });

  it("shows the stale indicator on an old digest", async () => {
    renderOn("today-stale");
    const badge = await screen.findByTestId("today-stale");
    expect(badge.textContent).toBe("Stale · 2 h 20 min old");
    expect(badge.getAttribute("title")).toContain("Gmail connector timed out");
  });

  it("shows friendly empty states", async () => {
    renderOn("today-empty");
    await screen.findByText("Nothing on the calendar today.");
    for (const text of [
      "Nothing worth reading right now.",
      "No mentions or DMs.",
      "Nothing due today.",
      "No session is waiting on you.",
    ])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(/JARVIS skipped/)).toBeNull();
  });

  it("plays the morning brief when the server has it, and hides the button when it doesn't", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const bridge = renderOn("today");
    const button = await screen.findByRole("button", { name: "Play morning brief" });
    fireEvent.click(button);
    await settle();
    expect(bridge.requests).toContainEqual({ path: "/brief", body: {} });
    expect(button.textContent).toBe("Brief on its way");
    await act(async () => void vi.advanceTimersByTime(BRIEF_SENT_MS));
    expect(button.textContent).toBe("Play morning brief");
    cleanup();

    const base = findScenario("today")!;
    const data = { ...base.data };
    delete data["/brief"];
    renderWith(createMockBridge({ ...base, data }));
    await screen.findByText("Lunch with Sam");
    await settle();
    expect(screen.queryByRole("button", { name: "Play morning brief" })).toBeNull();
  });

  it("refreshes, then re-reads the digest on today.updated and the to-dos on tasks.changed", async () => {
    const base = findScenario("today")!;
    // The bridge copies scenario data when it's made, so the live answers are functions of `live`.
    const live: Record<string, unknown> = { ...base.data };
    const scenario: Scenario = {
      ...base,
      data: {
        ...base.data,
        "/today": () => live["/today"],
        "/tasks?view=today": () => live["/tasks?view=today"],
      },
    };
    const mock = createMockBridge(scenario);
    const listeners = new Set<(e: DeskEvent) => void>();
    const emit = (e: DeskEvent) => act(async () => listeners.forEach((fn) => fn(e)));
    const bridge = renderWith({
      ...mock,
      subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    } as MockBridge);
    await screen.findByText("Lunch with Sam");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(bridge.requests).toContainEqual({ path: "/today/refresh", body: {} });
    expect(screen.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("true");

    // The worker finishes: a new Slack mention.
    const fresh = structuredClone(live["/today"] as TodayResponse);
    fresh.digest!.slack = [{ who: "Alex", where: "DM", line: "New logo is up", at: "2026-10-14T08:59:00Z" }];
    live["/today"] = fresh;
    await emit({ type: "today.updated", generatedAt: fresh.digest!.generatedAt });
    await settle();
    expect(screen.getByText("New logo is up")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("false");

    // A to-do was done elsewhere: it leaves the list.
    live["/tasks?view=today"] = { view: "today", tasks: fresh.digest!.tasksDue.slice(1) };
    await emit({ type: "tasks.changed" });
    await settle();
    expect(screen.queryByText("Answer trip: hotel budget")).toBeNull();
    expect(screen.getByText("Review onboarding copy for Priya")).toBeTruthy();
  });
});

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { MockBridge } from "../../mock/bridge";
import Calendar from "./index";

// The scenarios are London times (the demo week is in BST).
process.env.TZ = "Europe/London";

function open(scenario: string) {
  const choice = chooseBridge(`?scenario=${scenario}`, undefined);
  const bridge = choice.bridge as MockBridge;
  const chats: string[] = [];
  bridge.subscribe((e) => e.type === "brain.start" && chats.push(e.text));
  render(
    <BridgeProvider value={choice}>
      <Calendar />
    </BridgeProvider>,
  );
  return { bridge, chats };
}

/** Lets the mock's chat timers (0 ms) fire. */
const tick = () => act(() => new Promise((r) => setTimeout(r, 10)));

describe("Calendar window", () => {
  afterEach(() => cleanup());

  it("shows the week from the scenario's clock, and switches to day and month", async () => {
    const { bridge } = open("calendar");
    expect(screen.getByRole("heading", { name: "12 – 18 October 2026" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Investor update, Wed 14 Oct/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByRole("heading", { name: "Wednesday 14 October 2026" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Trip planning call/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Retro/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeTruthy();
    // Wednesday has four events: three chips and "+1 more", which opens the day.
    fireEvent.click(await screen.findByRole("button", { name: "1 more on Wed 14 Oct" }));
    expect(screen.getByRole("heading", { name: "Wednesday 14 October 2026" })).toBeTruthy();
    bridge.close();
  });

  it("clicking an event fills the panel; Prep me asks JARVIS", async () => {
    const { bridge, chats } = open("calendar");
    fireEvent.click(await screen.findByRole("button", { name: /^Trip planning call/ }));
    const panel = screen.getByRole("region", { name: "Selected event" });
    expect(panel.textContent).toContain("Wed 14 Oct · 16:00 – 16:45");
    expect(panel.textContent).toContain("Google Meet");
    expect(panel.textContent).toContain("With Sam, Jo, Priya");
    expect(within(panel).getByRole("link", { name: "Open in Notion" }).getAttribute("href")).toBe(
      "https://www.notion.so/Trip-planning-agenda-3f924983f3ca81aa",
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Prep me for this" }));
    await tick();
    expect(chats).toEqual(["prep me for Trip planning call"]);
    expect(bridge.opened).toEqual(["chat"]);
    bridge.close();
  });

  it("New event sends a sentence to JARVIS", async () => {
    const { bridge, chats } = open("calendar");
    fireEvent.click(screen.getByRole("button", { name: "New event" }));
    const form = screen.getByRole("dialog", { name: "New event" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Booking call" } });
    fireEvent.change(within(form).getByLabelText("Day"), { target: { value: "2026-10-16" } });
    fireEvent.change(within(form).getByLabelText("Start"), { target: { value: "12:00" } });
    fireEvent.change(within(form).getByLabelText("Guests"), { target: { value: "Sam" } });
    fireEvent.click(within(form).getByRole("button", { name: "Ask JARVIS" }));
    await tick();
    expect(chats).toEqual(["Create ‘Booking call’ Fri 16 Oct 12:00 for 30 min with Sam"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    bridge.close();
  });

  it("lists free slots and JARVIS's changes; Undo sends “undo that”", async () => {
    const { bridge, chats } = open("calendar-changed");
    const log = screen.getByRole("region", { name: "Changed by JARVIS" });
    const undo = await within(log).findByRole("button", {
      name: "Undo: Moved “Booking call” → Fri 16 Oct 12:00",
    });
    expect(screen.getByRole("region", { name: "Free this week" }).textContent).toContain("Wed 09:45 – 11:00");
    fireEvent.click(undo);
    await tick();
    expect(chats).toEqual(["undo that"]);
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    bridge.close();
  });

  it("shows a skeleton while the week is fetched, and Try again when it fails", async () => {
    const loading = open("calendar-loading");
    expect(screen.getByTestId("calendar-skeleton")).toBeTruthy();
    loading.bridge.close();
    cleanup();
    const failed = open("calendar-error");
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the calendar");
    failed.bridge.close();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import Ideas from "./index";

let bridge: MockBridge;

function renderIdeas(scenario: string) {
  bridge = createMockBridge(findScenario(scenario)!);
  render(
    <BridgeProvider value={{ bridge, scenario }}>
      <Ideas />
    </BridgeProvider>,
  );
}

const box = () => screen.getByLabelText("Idea", { selector: "textarea" }) as HTMLTextAreaElement;
const action = (id: string) => document.querySelector(`[data-action="${id}"]`)!;

describe("Ideas window", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("groups ideas by project with Unsorted last, and opens on a new idea", async () => {
    renderIdeas("ideas");
    await screen.findByText("Voice notes straight into Ideas.");
    const groups = screen.getAllByRole("region").filter((r) => r.tagName === "SECTION" && r.closest("nav"));
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "JARVIS Desk",
      "Trip planner",
      "mk",
      "Unsorted",
    ]);
    expect(box().value).toBe("");
    expect(screen.queryByText(/synced with Notion/)).toBeNull();
  });

  it("⌘↵ saves a new idea into the selected project; picking one loads it into the box", async () => {
    renderIdeas("ideas");
    await screen.findByText("Voice notes straight into Ideas.");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "trip" } });
    fireEvent.change(box(), { target: { value: "Pack list from the itinerary" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(bridge.requests.some((r) => r.path === "/ideas" && r.body)).toBe(true));
    expect(bridge.requests.find((r) => r.path === "/ideas" && r.body)?.body).toEqual({
      text: "Pack list from the itinerary",
      project: "trip",
    });
    const trip = await screen.findByRole("region", { name: "Trip planner" });
    await within(trip).findByText("Pack list from the itinerary");

    fireEvent.click(screen.getByText("Auto-hold flights when Sam confirms dates in email."));
    expect(box().value).toBe("Auto-hold flights when Sam confirms dates in email.");
  });

  it("a pop-up with typed context stays open after the pointer leaves; Go sends it and adds history", async () => {
    renderIdeas("ideas");
    fireEvent.click(
      await screen.findByText(
        "Orb shows a ring per running builder, so I can see how busy the agents are without opening anything.",
      ),
    );
    fireEvent.mouseEnter(action("todo"));
    const input = screen.getByLabelText("Add to to-dos: extra context");
    fireEvent.change(input, { target: { value: "this week" } });
    fireEvent.mouseLeave(action("todo"));
    expect(screen.getByRole("dialog", { name: "Add to to-dos" })).toBeTruthy();
    // Another button's hover doesn't open while this one holds a draft.
    fireEvent.mouseEnter(action("chat"));
    expect(screen.queryByRole("dialog", { name: "Chat with JARVIS" })).toBeNull();
    fireEvent.mouseLeave(action("chat"));
    // A click elsewhere keeps the draft: the amber dot.
    fireEvent.mouseDown(box());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("img", { name: "has a draft" })).toBeTruthy();

    fireEvent.click(within(action("todo") as HTMLElement).getByRole("button", { name: /Add to to-dos/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
    });
    await screen.findByText(/^Suggested in To-do/);
    expect(bridge.requests.find((r) => r.path === "/ideas/ring/todo")).toEqual({
      path: "/ideas/ring/todo",
      body: { context: "this week" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Chat with JARVIS opens the Chat window; a failed action shows an error line", async () => {
    renderIdeas("ideas");
    fireEvent.click(await screen.findByText("Read-later queue from Slack saves."));
    fireEvent.mouseEnter(action("chat"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
    });
    await waitFor(() => expect(bridge.opened).toContain("chat"));
    cleanup();
    bridge.close();

    renderIdeas("ideas-error");
    fireEvent.click(await screen.findByText("Read-later queue from Slack saves."));
    fireEvent.mouseEnter(action("session"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't start a session: JARVIS didn't answer (502 Bad Gateway).",
    );
  });

  it("with no ideas the sidebar says so", async () => {
    renderIdeas("ideas-empty");
    await screen.findByText("No ideas yet. Write one on the right.");
  });
});

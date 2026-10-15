import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import Todo from "./index";

let bridge: MockBridge;

function renderTodo(scenario: string) {
  bridge = createMockBridge(findScenario(scenario)!);
  render(
    <BridgeProvider value={{ bridge, scenario }}>
      <Todo />
    </BridgeProvider>,
  );
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const suggestionRows = () => document.querySelectorAll(".todo-suggestion");

describe("To-do window", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("shows suggestions with their sources, tabs with counts and the Notion link", async () => {
    renderTodo("todo");
    await screen.findByText("Pick a flight option for the trip");
    expect(suggestionRows()).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Suggested by JARVIS · 3 new" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Source: Session (opens it)" })).toBeTruthy();
    expect(tab("Today").textContent).toBe("Today3");
    expect(tab("Done").textContent).toBe("Done2");
    expect(screen.getByRole("link", { name: "Open JARVIS Tasks in Notion" }).getAttribute("href")).toMatch(
      /notion\.so/,
    );
  });

  it("Add moves a suggestion into Today; Dismiss removes one; Accept all empties the strip", async () => {
    renderTodo("todo");
    fireEvent.click(await screen.findByRole("button", { name: /^Add “Decide MK-81/ }));
    expect(suggestionRows()).toHaveLength(2);
    expect(within(screen.getByRole("tabpanel")).getByText(/Decide MK-81/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss “Pick a flight/ }));
    expect(suggestionRows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(suggestionRows()).toHaveLength(0);
    await waitFor(() => expect(tab("Upcoming").textContent).toBe("Upcoming5"));
  });

  it("ticking a task moves it to Done", async () => {
    renderTodo("todo");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Done: Review shapemint build failure" }));
    expect(screen.queryByRole("checkbox", { name: "Done: Review shapemint build failure" })).toBeNull();
    fireEvent.click(tab("Done"));
    const box = screen.getByRole("checkbox", { name: "Done: Review shapemint build failure" });
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("rolls a failed tick back and says why", async () => {
    renderTodo("todo-error");
    const box = await screen.findByRole("checkbox", { name: "Done: Review shapemint build failure" });
    fireEvent.click(box);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Couldn't mark it done \(“Review shapemint build failure”\): Notion didn't answer/,
    );
    const back = screen.getByRole("checkbox", { name: "Done: Review shapemint build failure" });
    expect((back as HTMLInputElement).checked).toBe(false);
  });

  it("adds plain text directly and sends text with a date to JARVIS", async () => {
    renderTodo("todo");
    const chat = vi.spyOn(bridge, "chat");
    const input = await screen.findByRole("textbox", { name: "Add a task" });
    fireEvent.change(input, { target: { value: "Buy milk" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(tab("Upcoming"));
    expect(await screen.findByText("Buy milk")).toBeTruthy();
    fireEvent.change(input, { target: { value: "call Sam on Friday" } });
    fireEvent.submit(input.closest("form")!);
    expect(chat).toHaveBeenCalledWith("add call Sam on Friday", "desk-typed");
    expect((await screen.findByRole("status")).textContent).toBe("Asked JARVIS: “add call Sam on Friday”");
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { NOTION_IDS } from "../../mock/data/notion";
import { findScenario } from "../../mock/scenarios";
import NotionWindow from "./index";

let bridge: MockBridge;

function renderNotion(scenario: string) {
  bridge = createMockBridge(findScenario(scenario)!);
  render(
    <BridgeProvider value={{ bridge, scenario }}>
      <NotionWindow />
    </BridgeProvider>,
  );
}

const side = () => screen.getByRole("complementary", { name: "Notion pages" });
const section = (name: RegExp) => within(side()).getByRole("region", { name });

describe("Notion window", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("opens the last page read: properties, headings, nested bullets, read-only to-dos, code", async () => {
    renderNotion("notion");
    expect(await screen.findByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText("12 Oct 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Goals" })).toBeTruthy();
    expect(
      screen.getByText("Ghosts are saved per track, in the browser").closest("ul")?.parentElement?.tagName,
    ).toBe("LI");
    const todo = screen.getByRole("checkbox", { name: "Drift boost tuning (MK-81)" }) as HTMLInputElement;
    expect(todo.checked).toBe(false);
    fireEvent.click(todo);
    expect(todo.checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Ghost replay" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/const SPEED_CAP/)).toBeTruthy();
    // Pinned and recent, each page once.
    expect(
      within(section(/PINNED/))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["JARVIS Tasksdatabase", "JARVIS Memory", "Mario Kart PRD"]);
    expect(within(section(/RECENT/)).getAllByRole("button")).toHaveLength(4);
  });

  it("child pages open inside the window; Back returns", async () => {
    renderNotion("notion");
    fireEvent.click(await screen.findByRole("button", { name: "Track list" }));
    expect(await screen.findByRole("heading", { name: "Track list", level: 2 })).toBeTruthy();
    expect(screen.getByText("Canyon: a long jump and two hairpins").closest("ol")).toBeTruthy();
    expect(within(section(/RECENT/)).getAllByRole("button")[0]!.textContent).toBe("Track list");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeTruthy();
  });

  it("search filters by title after a pause; Escape goes back to pinned", async () => {
    renderNotion("notion");
    await screen.findByRole("heading", { name: "Mario Kart PRD", level: 2 });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Notion" }), { target: { value: "prd" } });
    const results = await screen.findByRole("region", { name: /RESULTS · 3/ });
    expect(
      within(results)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mario Kart PRD", "Trip planner PRD", "Shapemint PRD"]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(await screen.findByText("No pages match “zzz”.")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(section(/PINNED/)).toBeTruthy();
  });

  it("pin and unpin go to the server; Tasks and Memory can't be unpinned", async () => {
    renderNotion("notion");
    const pin = await screen.findByRole("button", { name: "Pinned" });
    fireEvent.click(pin);
    await waitFor(() => expect(within(section(/PINNED/)).getAllByRole("button")).toHaveLength(2));
    expect(bridge.requests.at(-1)).toEqual({ path: `/notion/pinned/${NOTION_IDS.mkPrd}/unpin`, body: {} });
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(within(section(/PINNED/)).getAllByRole("button")).toHaveLength(3));
    expect(bridge.requests.at(-1)).toEqual({
      path: `/notion/pinned/${NOTION_IDS.mkPrd}`,
      body: { title: "Mario Kart PRD", kind: "page" },
    });
    fireEvent.click(within(section(/PINNED/)).getByRole("button", { name: "JARVIS Memory" }));
    await screen.findByRole("heading", { name: "JARVIS Memory", level: 2 });
    expect((screen.getByRole("button", { name: "Pinned" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Ask JARVIS sends the page title and id to chat; Full view is a placeholder", async () => {
    renderNotion("notion");
    fireEvent.click(await screen.findByRole("button", { name: "Ask JARVIS about this page" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Asked JARVIS about “Mario Kart PRD”. Open Chat",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Full view (notion.so, editable)" }));
    expect(screen.getByRole("heading", { name: "Full view works in the app" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open “Mario Kart PRD” on notion.so" }).getAttribute("href"),
    ).toMatch(/notion\.so/);
  });

  it("without Notion connected, search says what to do", async () => {
    renderNotion("notion-off");
    expect(await screen.findByText("Search, or pick a page on the left.")).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "PRD" } });
    });
    expect(await screen.findByText(/NOTION_TOKEN is not set/)).toBeTruthy();
  });
});

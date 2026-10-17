import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import type { Scenario } from "../../mock/types";
import AgentsWindow from "./index";

function renderOn(scenario: string | Scenario, withWebview = false) {
  const s = typeof scenario === "string" ? findScenario(scenario)! : scenario;
  const bridge = createMockBridge(s);
  const webview = { show: vi.fn(), hide: vi.fn() };
  if (withWebview) Object.assign(bridge, { webview });
  render(
    <BridgeProvider value={{ bridge, scenario: s.name }}>
      <AgentsWindow />
    </BridgeProvider>,
  );
  return { bridge: bridge as MockBridge, webview };
}

const card = (name: RegExp | string) => screen.findByRole("button", { name });
const panel = () => screen.getByRole("complementary", { name: "Details" });

describe("Agents window", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("draws the tree: projects, orchestrators and builders with their badges and CI", async () => {
    renderOn("agents");
    expect(await card("Project JARVIS Desk")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project Trip planner" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Orchestrator JARVIS batch 13 orchestrator" })).toBeTruthy();
    const jd57 = screen.getByRole("button", { name: /^Builder JD-57/ });
    expect(within(jd57).getByText("Failed 1 of 2")).toBeTruthy();
    expect(within(jd57).getByText("#72")).toBeTruthy();
    expect(within(jd57).getByText("session")).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /^Builder JD-47/ })).getByText("sub-agent"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /^Builder JD-55/ })).getByText("Running 1/2"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Builder Try the dashboard's dark theme/ })).toBeTruthy();
  });

  it("clicking a builder shows its details with every CI check; Close hides them", async () => {
    renderOn("agents");
    fireEvent.click(await card(/^Builder JD-57/));
    expect(within(panel()).getByRole("heading", { name: /JD-57: Agent graph/ })).toBeTruthy();
    const ci = within(panel()).getByRole("region", { name: "CI" });
    expect(
      within(ci)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("desk"), expect.stringContaining("server")]);
    expect(await within(panel()).findByText(/expected 3 builders, got 2/)).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
  });

  it("Open shows claude.ai and Notion in the window's full view; GitHub goes to the browser", async () => {
    const { webview } = renderOn("agents", true);
    fireEvent.click(await card(/^Builder JD-57/));
    const open = within(panel()).getByRole("group", { name: /^Open/ });
    expect(
      within(open)
        .getByRole("link", { name: /PR #72 on GitHub/ })
        .getAttribute("href"),
    ).toBe("https://github.com/MattSharp05/VirtualAssistant/pull/72");
    fireEvent.click(within(open).getByRole("button", { name: "Session on claude.ai" }));
    expect(webview.show).toHaveBeenLastCalledWith(
      "https://claude.ai/code/session_01JD57",
      expect.any(Object),
    );
    fireEvent.click(screen.getByRole("button", { name: "← Back to the tree" }));
    expect(webview.hide).toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: "Ticket JD-57 in Notion" }));
    expect(webview.show).toHaveBeenLastCalledWith("https://app.notion.com/p/jd-57", expect.any(Object));
    fireEvent.click(screen.getByRole("button", { name: "← Back to the tree" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Run page in Notion" }));
    expect(webview.show).toHaveBeenLastCalledWith(
      "https://app.notion.com/p/3fc24983f3ca81aa9c1e00000000b013",
      expect.any(Object),
    );
  });

  it("collapses and expands a run", async () => {
    renderOn("agents");
    const toggle = await screen.findByRole("button", {
      name: "Collapse Orchestrator JARVIS batch 13 orchestrator",
    });
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /^Builder JD-54/ })).toBeNull();
    const expand = screen.getByRole("button", { name: "Expand Orchestrator JARVIS batch 13 orchestrator" });
    expect(expand.textContent).toBe("+3");
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: /^Builder JD-54/ })).toBeTruthy();
  });

  it("filters: active only, one project, and a ticket search", async () => {
    renderOn("agents");
    await card(/^Builder JD-47/);
    fireEvent.click(screen.getByRole("button", { name: "Active only" }));
    expect(screen.queryByRole("button", { name: /^Builder JD-47/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "project:trip" } });
    expect(screen.queryByRole("button", { name: "Project JARVIS Desk" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search by ticket ID"), { target: { value: "JD-57" } });
    expect(screen.getAllByRole("button", { name: /^Builder/ })).toHaveLength(1);
    expect(screen.getByText("1 match")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search by ticket ID"), { target: { value: "ZZ-9" } });
    expect(screen.getByText("No builder matches “ZZ-9”.")).toBeTruthy();
  });

  it("a live update re-fetches, keeps the selection and flashes what changed", async () => {
    const live = findScenario("agents-live")!;
    renderOn({
      ...live,
      events: [{ after: 400, event: { type: "agents.changed", ids: ["session:session_01JD55"] } }],
    });
    fireEvent.click(await card(/^Builder JD-55/));
    expect(within(panel()).getByText("Running 1/2")).toBeTruthy();
    expect(await within(panel()).findByText("Passed 2/2")).toBeTruthy();
    expect(within(panel()).getByRole("heading", { name: /JD-55/ })).toBeTruthy();
    const node = document.querySelector('[data-node-id="session:session_01JD55"]')!;
    expect(node.hasAttribute("data-flash")).toBe(true);
  });

  it("the keyboard pans and zooms the canvas", async () => {
    renderOn("agents");
    await card("Project JARVIS Desk");
    const canvas = screen.getByRole("group", { name: "Agent tree" });
    const world = canvas.firstElementChild as HTMLElement;
    const before = world.style.transform;
    act(() => void fireEvent.keyDown(canvas, { key: "ArrowLeft" }));
    expect(world.style.transform).not.toBe(before);
    act(() => void fireEvent.keyDown(canvas, { key: "+" }));
    expect(screen.getByLabelText("Zoom level").textContent).toBe("120%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByLabelText("Zoom level").textContent).toBe("100%");
  });

  it("empty and loading states", async () => {
    renderOn("agents-empty");
    expect(await screen.findByText("No agents yet")).toBeTruthy();
    cleanup();
    renderOn("agents-loading");
    expect(screen.getByText("Loading agents…")).toBeTruthy();
  });

  it("?node= selects that node", async () => {
    window.location.hash = "#/agents?node=ticket:TR-22";
    renderOn("agents");
    expect(await screen.findByRole("heading", { name: /TR-22: Itinerary export/ })).toBeTruthy();
  });
});

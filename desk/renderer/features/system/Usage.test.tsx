import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { system } from "../../mock/data/system";
import { findScenario } from "../../mock/scenarios";
import type { Scenario } from "../../mock/types";
import System from "./index";

let bridge: MockBridge;

function renderSystem(scenario: string, custom?: Scenario) {
  bridge = createMockBridge(custom ?? findScenario(scenario)!);
  render(
    <BridgeProvider value={{ bridge, scenario }}>
      <System />
    </BridgeProvider>,
  );
}

const projectsTable = () =>
  within(screen.getByRole("region", { name: "PROJECTS · CLOUD SESSIONS" })).getByRole("table");
const firstColumn = () =>
  within(projectsTable())
    .getAllByRole("rowheader")
    .map((th) => th.textContent);

describe("System window: projects and history (JD-55)", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("lists projects for the last 7 days, sortable, and switches to all time", async () => {
    renderSystem("system");
    await screen.findByRole("heading", { name: "PROJECTS · CLOUD SESSIONS" });
    expect(firstColumn()).toEqual(["mario-kart", "jarvis", "trip-planner", "Other", "shapemint"]);
    const cost = within(projectsTable()).getByRole("columnheader", { name: /^Cost/ });
    expect(cost.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(cost).getByRole("button"));
    expect(cost.getAttribute("aria-sort")).toBe("ascending");
    expect(firstColumn()[0]).toBe("shapemint");
    fireEvent.click(within(projectsTable()).getByRole("button", { name: /^Project/ }));
    expect(firstColumn()).toEqual(["jarvis", "mario-kart", "Other", "shapemint", "trip-planner"]);

    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(screen.getByRole("button", { name: "All time" }).getAttribute("aria-pressed")).toBe("true");
    const jarvis = within(projectsTable()).getByRole("row", { name: /^jarvis/ });
    // 30 days of jarvis plus $212.60 before; 6 + 7 sessions; one working now.
    expect(within(jarvis).getAllByRole("cell")[0].textContent).toMatch(/^\$\d{3}\.\d\d$/);
    expect(within(jarvis).getAllByRole("cell")[2].textContent).toBe("13");
    expect(within(jarvis).getAllByRole("cell")[3].textContent).toBe("1");
  });

  it("draws 30 stacked days with a colour per project and the day's numbers on focus", async () => {
    renderSystem("system");
    const chart = await screen.findByRole("group", {
      name: "Cost per day over the last 30 days, by project",
    });
    const days = within(chart).getAllByRole("img");
    expect(days).toHaveLength(30);
    expect(days[29].getAttribute("aria-label")).toMatch(/^Wed 14 Oct: \$\d+\.\d\d \(jarvis \$/);
    const legend = screen.getByRole("list", { name: "Projects" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => [li.textContent, li.getAttribute("data-slot")]),
    ).toEqual([
      ["jarvis", "1"],
      ["mario-kart", "2"],
      ["shapemint", "3"],
      ["trip-planner", "4"],
      ["Other", "other"],
    ]);

    fireEvent.focus(days[29]);
    expect(document.querySelector(".usage-tip")?.textContent).toContain("Wed 14 Oct");
    expect(document.querySelectorAll(".usage-bar[data-dim]")).toHaveLength(29);
    fireEvent.blur(days[29]);
    expect(document.querySelector(".usage-tip")).toBeNull();

    const history = screen.getByRole("region", { name: /^LAST 30 DAYS/ });
    fireEvent.click(within(history).getByRole("button", { name: "Tokens" }));
    expect(
      screen.getByRole("group", { name: "Tokens per day over the last 30 days, by project" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "LAST 30 DAYS · TOKENS PER DAY" })).toBeTruthy();
  });

  it("folds the smallest projects into Other when there are more than five", async () => {
    renderSystem("system-history");
    const legend = await screen.findByRole("list", { name: "Projects" });
    const names = within(legend)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(names).toHaveLength(6);
    expect(names.at(-1)).toBe("Other");
    expect(firstColumn()).toHaveLength(9);
    // A folded project's row dot is Other's colour.
    const recipes = within(projectsTable()).getByRole("rowheader", { name: "recipes" });
    expect(recipes.getAttribute("data-slot")).toBe("other");
  });

  it("says so before the first snapshot, and shows nothing on an older server", async () => {
    renderSystem("system-history-empty");
    await screen.findByText(/No cloud session use recorded yet/);
    expect(screen.getByText("No cloud sessions recorded yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
    cleanup();
    bridge.close();
    const older = { ...system };
    delete older.projects;
    delete older.history;
    renderSystem("older", { name: "older", description: "", data: { "/system": older }, events: [] });
    await screen.findByRole("heading", { name: "CLAUDE PLAN" });
    expect(screen.queryByRole("heading", { name: "PROJECTS · CLOUD SESSIONS" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^LAST 30 DAYS/ })).toBeNull();
  });
});

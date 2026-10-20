import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { FOLLOW_UP_MS } from "../../mock/browserTasks";
import { findScenario } from "../../mock/scenarios";
import BrowserWindow from "./index";
import { MORE_ABOUT } from "./TaskResults";

let bridge: MockBridge;

function renderOn(scenario: string) {
  const found = findScenario(scenario)!;
  bridge = createMockBridge(found);
  render(
    <BridgeProvider value={{ bridge, scenario, ...(found.ui ? { ui: found.ui } : {}) }}>
      <BrowserWindow />
    </BridgeProvider>,
  );
}

const wait = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const posts = () => bridge.requests.filter((r) => r.body !== undefined).map((r) => [r.path, r.body]);
const results = () => screen.getByRole("region", { name: "Results" });

describe("browser task results (JD-66)", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("lists the results under the log, with the page's site on rows that have one", async () => {
    renderOn("browser-task-results");
    await wait();
    const panel = results();
    expect(within(panel).getByRole("heading").textContent).toBe("Tampa → Johannesburg, one way, Dec 10–12");
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("flights.example");
    expect(rows[0]!.textContent).toContain("$958");
    expect(rows[2]!.getAttribute("data-link")).toBe("none");
  });

  it("a row with its own page opens it in the Browser window, with no agent turn", async () => {
    renderOn("browser-task-results");
    await wait();
    fireEvent.click(within(results()).getByRole("button", { name: /Fri Dec 11 · JetBlue/ }));
    await wait();
    expect(bridge.browser!.commands.at(-1)).toEqual({
      type: "go",
      address: "https://flights.example/fare/tpa-jnb-dec11-958",
    });
    expect(posts()).toEqual([]);
  });

  it("a row without a page, or a question typed under one, picks the task back up; the answer lands in the log", async () => {
    renderOn("browser-task-results");
    await wait();
    fireEvent.click(within(results()).getByRole("button", { name: /Sat Dec 12/ }));
    await wait();
    expect(posts()).toEqual([["/browser/tasks/task-jnb/followup", { text: MORE_ABOUT, item: 2 }]]);
    expect(screen.getByRole("status", { name: "Task state" }).textContent).toBe("Working");
    // While it works, the other rows' questions wait.
    expect(within(results()).getByRole("textbox", { name: /Ask about Fri Dec 11 · JetBlue/ })).toHaveProperty(
      "disabled",
      true,
    );
    await wait(FOLLOW_UP_MS + 50);
    expect(screen.getByRole("status", { name: "Task state" }).textContent).toBe("Done");

    const ask = within(results()).getByRole("textbox", { name: /Ask about Fri Dec 11 · JetBlue/ });
    fireEvent.change(ask, { target: { value: "Where are the stops?" } });
    fireEvent.submit(ask.closest("form")!);
    await wait();
    expect(posts().at(-1)).toEqual([
      "/browser/tasks/task-jnb/followup",
      { text: "Where are the stops?", item: 0 },
    ]);
    const log = screen.getByRole("list", { name: "Progress" });
    expect(log.textContent).toContain(
      "Matthew followed up on “Fri Dec 11 · JetBlue + Turkish, 2 stops”: Where are the stops?",
    );
    await wait(FOLLOW_UP_MS + 50);
    expect(log.textContent).toContain("has 2 stops (Toronto, then Istanbul)");
    expect((ask as HTMLInputElement).value).toBe("");
  });

  it("“add it to my to-do list” under a row goes to the task, which adds a JARVIS Task", async () => {
    renderOn("browser-task-results");
    await wait();
    const ask = within(results()).getByRole("textbox", { name: /Ask about Thu Dec 10/ });
    fireEvent.change(ask, { target: { value: "add it to my to-do list" } });
    fireEvent.click(within(ask.closest("form")!).getByRole("button", { name: "Ask" }));
    await wait(FOLLOW_UP_MS + 50);
    expect(posts()).toEqual([
      ["/browser/tasks/task-jnb/followup", { text: "add it to my to-do list", item: 1 }],
    ]);
    expect(screen.getByRole("list", { name: "Progress" }).textContent).toContain(
      "Added “Book: Thu Dec 10 · Air Canada + Emirates, 2 stops, $1,188” to your to-do list.",
    );
  });

  it("with the sidebar closed, the pill shows the result and reopens the results", async () => {
    renderOn("browser-task-results-closed");
    await wait();
    expect(screen.queryByRole("region", { name: "Results" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done · show the result" }));
    expect(within(results()).getAllByRole("listitem")).toHaveLength(4);
  });
});

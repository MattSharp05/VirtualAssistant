import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import BrowserWindow from "./index";

// History's delete (JD-67): a finished task goes for good after the trash button and a confirm; an
// active one has to be stopped first.

let bridge: MockBridge;

function openHistory(scenario: string) {
  const s = findScenario(scenario)!;
  bridge = createMockBridge(s);
  render(
    <BridgeProvider value={{ bridge, scenario, ...(s.ui ? { ui: s.ui } : {}) }}>
      <BrowserWindow />
    </BridgeProvider>,
  );
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const history = () => screen.getByRole("region", { name: "Browser task history" });
const items = () => within(within(history()).getByRole("list", { name: "Tasks" })).getAllByRole("button");

afterEach(cleanup);

describe("History: delete a task for good", () => {
  it("trash, then confirm: the task leaves the list and the stored log", async () => {
    openHistory("browser-task-history");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await flush();
    expect(items()).toHaveLength(3);
    fireEvent.click(items().find((b) => /Renew the parking permit/.test(b.textContent ?? ""))!);
    await flush();

    fireEvent.click(within(history()).getByRole("button", { name: "Delete task" }));
    const confirm = within(history()).getByRole("group", { name: "Confirm delete" });
    expect(confirm.textContent).toContain("for good");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(history()).queryByRole("group", { name: "Confirm delete" })).toBeNull();
    expect(bridge.requests.some((r) => r.path.endsWith("/delete"))).toBe(false);

    fireEvent.click(within(history()).getByRole("button", { name: "Delete task" }));
    fireEvent.click(within(history()).getByRole("button", { name: "Delete for good" }));
    await flush();
    expect(items()).toHaveLength(2);
    expect(items().some((b) => /Renew the parking permit/.test(b.textContent ?? ""))).toBe(false);
    expect(bridge.requests.filter((r) => r.path.endsWith("/delete")).map((r) => r.path)).toEqual([
      "/browser/tasks/task-permit/delete",
    ]);
    const left = await bridge.request<{ tasks: { id: string }[] }>("/browser/tasks");
    expect(left.tasks.map((t) => t.id)).not.toContain("task-permit");
    // The next task is chosen and its log shown.
    expect(within(history()).getByLabelText("Task log").textContent).not.toContain("Loading");
  });

  it("an active task can't be deleted: the trash is off until it's stopped", async () => {
    openHistory("browser-task-normal");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await flush();
    const trash = within(history()).getByRole("button", { name: "Delete task" }) as HTMLButtonElement;
    expect(trash.disabled).toBe(true);
    expect(history().textContent).toContain("Stop the task first to delete it.");
  });
});

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { DeskEvent } from "@jarvis/shared";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import { WindowTitleContext } from "../../app/windowTitle";
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
const projectToggles = () =>
  screen
    .queryAllByRole("button", { expanded: true })
    .concat(screen.queryAllByRole("button", { expanded: false }));
const projects = () =>
  [...document.querySelectorAll("[data-project]")].map((g) => [
    g.getAttribute("data-project"),
    g.querySelector(".sessions-project-summary")!.textContent,
    [...g.querySelectorAll("[data-session-id]")].map((r) => r.getAttribute("data-session-id")),
  ]);
const listReady = () => screen.findByRole("button", { name: "MarioKart" });

describe("Sessions window", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("groups by project by default, needs-you rows first, No project last; selects the first session that needs you", async () => {
    renderOn("sessions");
    await listReady();
    expect((screen.getByLabelText("Group") as HTMLSelectElement).value).toBe("project");
    expect(projects()).toEqual([
      ["MarioKart", "1 needs you · 1 working", ["mk", "mk-80-builder"]],
      ["Trip planner", "1 needs you", ["trip"]],
      ["ShapeMint", "1 working", ["session_01SM"]],
      ["JARVIS Desk", "1 idle", ["virtual-assistant"]],
      ["No project", "1 idle", ["notes-cleanup"]],
    ]);
    expect(await screen.findByText("Blocked · needs you", { selector: ".sessions-pill" })).toBeTruthy();
    expect(await screen.findByText(/drift boost at 1.5×/)).toBeTruthy();
  });

  it("a project folds away and opens again from its header", async () => {
    renderOn("sessions");
    const toggle = await listReady();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const rows = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(rows.hidden).toBe(true);
    expect(projectToggles()).toHaveLength(5);
    fireEvent.click(toggle);
    expect(rows.hidden).toBe(false);
  });

  it("Needs you first brings back the status groups", async () => {
    renderOn("sessions");
    await listReady();
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "needs-you" } });
    expect(groupTitles()).toEqual(["Needs you", "Working", "Idle", "mk"]);
  });

  it("Pop out opens the session in a window of its own", async () => {
    const bridge = renderOn("sessions");
    fireEvent.click(await screen.findByRole("button", { name: "Pop out mk into its own window" }));
    expect(bridge.opened).toEqual(["sessions?solo=mk"]);
    fireEvent.click(document.querySelector("[data-session-id=session_01SM]")!);
    fireEvent.click(await screen.findByRole("button", { name: /^Pop out ShapeMint/ }));
    expect(bridge.opened.at(-1)).toBe("sessions?solo=session_01SM");
  });

  it("a popped-out window shows just that session, titled with its name, and still sends and refreshes", async () => {
    const mock = createMockBridge(findScenario("sessions")!);
    const listeners: ((e: DeskEvent) => void)[] = [];
    const bridge = {
      ...mock,
      subscribe: (fn: (e: DeskEvent) => void) => (listeners.push(fn), () => undefined),
    };
    const titles: (string | undefined)[] = [];
    window.location.hash = "#/sessions?solo=trip";
    render(
      <BridgeProvider value={{ bridge, scenario: "sessions" }}>
        <WindowTitleContext.Provider value={(t) => titles.push(t)}>
          <SessionsWindow />
        </WindowTitleContext.Provider>
      </BridgeProvider>,
    );
    expect(await screen.findByRole("heading", { level: 2, name: "trip" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pop out/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Quick view" })).toBeTruthy();
    expect(titles.at(-1)).toBe("trip");

    const details = () => mock.requests.filter((r) => r.path === "/sessions/trip").length;
    const before = details();
    await act(async () => listeners.forEach((fn) => fn({ type: "sessions.changed" })));
    expect(details()).toBe(before + 1);

    fireEvent.change(screen.getByLabelText("Message trip"), { target: { value: "Thanks" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send to trip" })));
    expect(await screen.findByText("Sent to trip")).toBeTruthy();
  });

  it("the sessions-solo scenario starts popped out on mk", async () => {
    renderOn("sessions-solo");
    expect(await screen.findByRole("heading", { level: 2, name: "mk" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  });

  it("a popped-out session that's gone says so", async () => {
    renderOn("sessions", "#/sessions?solo=nope");
    expect(await screen.findByText("No session called nope any more.")).toBeTruthy();
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
    await listReady();
    fireEvent.change(screen.getByLabelText("Filter sessions"), { target: { value: "shapemint" } });
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    expect(within(nav).getAllByRole("button", { name: /ShapeMint/ })).toHaveLength(2);
    expect(projects()).toEqual([["ShapeMint", "1 working", ["session_01SM"]]]);
    fireEvent.change(screen.getByLabelText("Filter sessions"), { target: { value: "mariokart" } });
    expect(projects().map((p) => p[0])).toEqual(["MarioKart"]);
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
    await listReady();
    const lists = () => mock.requests.filter((r) => r.path === "/sessions").length;
    const before = lists();
    await act(async () => listeners.forEach((fn) => fn({ type: "sessions.changed" })));
    expect(lists()).toBe(before + 1);
  });

  it("Full view shows the session on claude.ai, stays on as another session is picked, and hides on Quick view", async () => {
    const mock = renderOn("sessions");
    const webview = { show: vi.fn(), hide: vi.fn() };
    mock.webview = webview;
    fireEvent.click(await screen.findByRole("tab", { name: "Full view (claude.ai)" }));
    expect(screen.getByRole("tab", { name: "Full view (claude.ai)" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByLabelText("Message mk")).toBeNull();
    expect(webview.show).toHaveBeenLastCalledWith("https://claude.ai/code/session_01MK", expect.anything());

    const nav = screen.getByRole("navigation", { name: "Sessions" });
    fireEvent.click(within(nav).getByRole("button", { name: /^trip/ }));
    await screen.findByRole("heading", { level: 2, name: "trip" });
    expect(webview.show).toHaveBeenLastCalledWith("https://claude.ai/code/session_01TR", expect.anything());

    fireEvent.click(screen.getByRole("tab", { name: "Quick view" }));
    expect(webview.hide).toHaveBeenCalled();
    expect(await screen.findByLabelText("Message trip")).toBeTruthy();
  });

  it("list rows show cost, tokens, wall time and the context bar; unknown values are — with a tooltip", async () => {
    renderOn("sessions");
    await listReady();
    const row = (id: string) => document.querySelector(`[data-session-id="${id}"]`)!;
    const metric = (id: string, m: string) => row(id).querySelector(`[data-metric="${m}"]`)!;
    expect(metric("mk", "cost").textContent).toBe("$269.76");
    expect(metric("mk", "tokens").textContent).toBe("832 M");
    expect(metric("mk", "wall").textContent).toBe("1d");
    expect(metric("mk", "context").textContent).toBe("27.1%");
    expect(row("mk").querySelector(".sessions-bar")!.getAttribute("data-tone")).toBe("ok");
    expect(row("virtual-assistant").querySelector(".sessions-bar")!.getAttribute("data-tone")).toBe("red");
    const unknown = metric("notes-cleanup", "cost").querySelector(".sessions-unknown")!;
    expect(unknown.getAttribute("title")).toBe("not reported by the API");
    expect(unknown.textContent).toMatch(/^—/);
    expect(row("notes-cleanup").textContent).not.toMatch(/\$0|0%/);
    expect(metric("notes-cleanup", "wall").textContent).toBe("1h");
  });

  it("the quick view's Metrics block splits the tokens and lists turns, tool calls, PRs and the model", async () => {
    renderOn("sessions");
    const block = await screen.findByRole("region", { name: "Metrics" });
    const value = (label: string) =>
      [...block.querySelectorAll(".sessions-metric")]
        .find((m) => m.querySelector("dt")!.textContent === label)!
        .querySelector("dd")!.textContent;
    expect(await within(block).findByText("14")).toBeTruthy();
    expect(value("Input")).toBe("98 k");
    expect(value("Output")).toBe("2.7 M");
    expect(value("Cache read")).toBe("821 M");
    expect(value("Cache write")).toBe("8.3 M");
    expect(value("Cost")).toBe("$269.76");
    expect(value("Context")).toMatch(/^271 k \/ 1 M27.1%$/);
    expect(value("Wall time")).toBe("1d 2h");
    expect(value("Active time")).toBe("7h 41m");
    expect(value("Tool calls")).toBe("612");
    expect(value("Model")).toBe("claude-opus-5-5");
    const prs = within(block).getAllByRole("link");
    expect(prs.map((a) => a.textContent)).toEqual([
      "MarioKart #76",
      "MarioKart #77",
      "MarioKart #78",
      "MarioKart #79",
    ]);
    expect(prs[0].getAttribute("href")).toBe("https://github.com/MattSharp05/MarioKart/pull/76");
  });

  it("an old session without usage shows — in the Metrics block, never 0", async () => {
    renderOn("sessions", "#/sessions?id=notes-cleanup");
    await screen.findByRole("heading", { level: 2, name: "notes-cleanup" });
    const block = await screen.findByRole("region", { name: "Metrics" });
    await within(block).findAllByTitle("not reported by the API");
    expect(within(block).queryByText("…")).toBeNull();
    for (const label of ["Cost", "Tokens", "Input", "Turns", "Tool calls", "PRs", "Model", "Active time"]) {
      const dd = within(block).getByText(label, { selector: "dt" }).nextElementSibling!;
      expect(dd.querySelector(".sessions-unknown"), label).toBeTruthy();
    }
    expect(block.textContent).not.toMatch(/\$0|\b0 k|0%/);
  });

  it("heavy: a red context bar, a lower-bound tool count and the configured model beside the served one", async () => {
    renderOn("sessions-metrics-heavy");
    const block = await screen.findByRole("region", { name: "Metrics" });
    expect(await within(block).findByText("2,410+")).toBeTruthy();
    expect(block.querySelector(".sessions-bar")!.getAttribute("data-tone")).toBe("red");
    expect(within(block).getByText("configured claude-opus-5-5")).toBeTruthy();
    expect(within(block).getByText(/lower bound/)).toBeTruthy();
    const builder = document.querySelector('[data-session-id="mk-80-builder"] .sessions-bar')!;
    expect(builder.getAttribute("data-tone")).toBe("amber");
  });

  it("sorts by cost or context into one list, and back to the groups", async () => {
    renderOn("sessions");
    await listReady();
    const order = () =>
      [...document.querySelectorAll("[data-session-id]")].map((r) => r.getAttribute("data-session-id"));
    const sort = screen.getByLabelText("Group");
    fireEvent.change(sort, { target: { value: "cost" } });
    expect(screen.getByRole("heading", { level: 2, name: "Most expensive" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Needs you" })).toBeNull();
    expect(order()).toEqual([
      "mk",
      "trip",
      "virtual-assistant",
      "session_01SM",
      "mk-80-builder",
      "notes-cleanup",
    ]);
    fireEvent.change(sort, { target: { value: "context" } });
    expect(order()).toEqual([
      "virtual-assistant",
      "mk-80-builder",
      "mk",
      "trip",
      "session_01SM",
      "notes-cleanup",
    ]);
    fireEvent.change(screen.getByLabelText("Filter sessions"), { target: { value: "mk" } });
    expect(order()).toEqual(["mk-80-builder", "mk"]);
    fireEvent.change(sort, { target: { value: "needs-you" } });
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  });

  it("empty: explains where sessions come from", async () => {
    renderOn("sessions-empty");
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
  });
});

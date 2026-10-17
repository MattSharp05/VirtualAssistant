import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserTaskSummary } from "@jarvis/shared";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import BrowserWindow from "./index";
import { SHOW_ENDED_MS, shownTask, upsertTask, when } from "./taskModel";

let bridge: MockBridge;

function renderOn(scenario: string) {
  bridge = createMockBridge(findScenario(scenario)!);
  render(
    <BridgeProvider
      value={{ bridge, scenario, ...(findScenario(scenario)!.ui ? { ui: findScenario(scenario)!.ui! } : {}) }}
    >
      <BrowserWindow />
    </BridgeProvider>,
  );
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const posts = () => bridge.requests.filter((r) => r.body !== undefined).map((r) => [r.path, r.body]);

const summary = (id: string, over: Partial<BrowserTaskSummary> = {}): BrowserTaskSummary => ({
  id,
  text: id,
  mode: "normal",
  status: "done",
  origin: "browser",
  startedAt: "2026-10-22T10:00:00Z",
  endedAt: "2026-10-22T10:05:00Z",
  steps: 3,
  ...over,
});

describe("browser task model", () => {
  it("keeps the newest first and replaces a task's old copy", () => {
    const list = [summary("b", { startedAt: "2026-10-22T11:00:00Z" }), summary("a")];
    const next = upsertTask(list, summary("a", { status: "stopped", startedAt: "2026-10-22T10:00:00Z" }));
    expect(next.map((t) => [t.id, t.status])).toEqual([
      ["b", "done"],
      ["a", "stopped"],
    ]);
    expect(upsertTask(next, summary("c", { startedAt: "2026-10-22T12:00:00Z" }))[0]!.id).toBe("c");
  });

  it("the strip shows the task going on, else the last one for a while after it ended (until cleared)", () => {
    const ended = Date.parse("2026-10-22T10:05:00Z");
    const done = [summary("a")];
    expect(shownTask(done, ended + 60_000)?.id).toBe("a");
    expect(shownTask(done, ended + SHOW_ENDED_MS + 1)).toBeUndefined();
    expect(shownTask(done, ended + 60_000, "a")).toBeUndefined();
    expect(shownTask(done, ended + SHOW_ENDED_MS * 10, undefined, "a")?.id).toBe("a");
    const waiting = [summary("b", { status: "done" }), summary("a", { status: "waiting" })];
    expect(shownTask(waiting, ended + SHOW_ENDED_MS * 10)?.id).toBe("a");
  });

  it("says when: today, yesterday, or the date", () => {
    const now = new Date(2026, 9, 22, 19, 0).getTime();
    expect(when(new Date(2026, 9, 22, 8, 5).toISOString(), now)).toBe("Today 08:05");
    expect(when(new Date(2026, 9, 21, 18, 40).toISOString(), now)).toBe("Yesterday 18:40");
    expect(when(new Date(2026, 9, 15, 9, 0).toISOString(), now)).toBe("Thu 15 Oct 09:00");
  });
});

describe("Browser window tasks (JD-60)", () => {
  afterEach(() => {
    cleanup();
    bridge.close();
  });

  it("Normal mode: the question band asks for an OK; Approve answers it and the task carries on", async () => {
    renderOn("browser-task-normal");
    await flush();
    const strip = screen.getByRole("region", { name: "Browser task" });
    expect(within(strip).getByText("Normal")).toBeTruthy();
    expect(within(strip).getByRole("status", { name: "Task state" }).textContent).toBe("Waiting for you");
    const band = screen.getByRole("region", { name: "JARVIS needs your OK" });
    expect(band.textContent).toContain("Book Taberna da Rua for 2 on Fri 23 Oct at 20:00?");
    fireEvent.click(within(band).getByRole("button", { name: "Approve" }));
    await flush();
    expect(posts()).toEqual([
      ["/browser/tasks/task-taberna/answer", { questionId: "q-book", answer: "approve" }],
    ]);
    expect(screen.queryByRole("region", { name: "JARVIS needs your OK" })).toBeNull();
    expect(screen.getByRole("status", { name: "Task state" }).textContent).toBe("Working");
  });

  it("Change asks what instead and sends it", async () => {
    renderOn("browser-task-normal");
    await flush();
    const band = screen.getByRole("region", { name: "JARVIS needs your OK" });
    fireEvent.click(within(band).getByRole("button", { name: "Change" }));
    const input = within(band).getByLabelText("What should JARVIS do instead?");
    fireEvent.change(input, { target: { value: "Make it 21:00" } });
    fireEvent.click(within(band).getByRole("button", { name: "Send" }));
    await flush();
    expect(posts()).toEqual([
      [
        "/browser/tasks/task-taberna/answer",
        { questionId: "q-book", answer: "change", text: "Make it 21:00" },
      ],
    ]);
  });

  it("Full autonomy: no question; Pause becomes Resume, and Stop ends it", async () => {
    renderOn("browser-task-full");
    await flush();
    const strip = screen.getByRole("region", { name: "Browser task" });
    expect(within(strip).getByText("Full autonomy")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /JARVIS needs your OK|Over to you/ })).toBeNull();
    fireEvent.click(within(strip).getByRole("button", { name: "Pause" }));
    await flush();
    expect(screen.getByRole("status", { name: "Task state" }).textContent).toBe("Paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    expect(posts().map(([p]) => p)).toEqual([
      "/browser/tasks/task-taberna-full/pause",
      "/browser/tasks/task-taberna-full/resume",
      "/browser/tasks/task-taberna-full/stop",
    ]);
    expect(screen.getByRole("status", { name: "Task state" }).textContent).toBe("Stopped");
    // The result stays until New task brings the box back.
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("form", { name: "New browser task" })).toBeTruthy();
  });

  it("password stop: Take over hands Matthew the browser; Hand back resumes the task", async () => {
    renderOn("browser-task-password-stop");
    await flush();
    const band = screen.getByRole("region", { name: "Over to you" });
    expect(band.textContent).toContain("asks for a password");
    fireEvent.click(within(band).getByRole("button", { name: "Take over" }));
    await flush();
    expect(bridge.browser.commands).toEqual([{ type: "take-over" }]);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Over to you" })).getByRole("button", { name: "Hand back" }),
    );
    await flush();
    expect(bridge.browser.commands).toEqual([{ type: "take-over" }, { type: "hand-back" }]);
    expect(posts()).toEqual([["/browser/tasks/task-taberna-signin/resume", {}]]);
    expect(screen.queryByRole("region", { name: "Over to you" })).toBeNull();
  });

  it("the task box starts a task, Normal unless switched to Full autonomy", async () => {
    renderOn("browser-idle");
    await flush();
    const box = screen.getByRole("form", { name: "New browser task" });
    const normal = within(box).getByRole("radio", { name: "Normal" });
    expect(normal.getAttribute("aria-checked")).toBe("true");
    expect((within(box).getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(box).getByLabelText("Task"), { target: { value: "Find flights to Lisbon" } });
    fireEvent.click(within(box).getByRole("radio", { name: "Full autonomy" }));
    fireEvent.click(within(box).getByRole("button", { name: "Start" }));
    await flush();
    // browser-idle's mock has no browser tasks: the error shows and the box keeps what was typed.
    expect(bridge.requests.at(-1)).toEqual({
      path: "/browser/tasks",
      body: { text: "Find flights to Lisbon", mode: "full" },
    });
    expect(screen.getByRole("alert").textContent).toMatch(/No mock data for \/browser\/tasks/);
    expect((within(box).getByLabelText("Task") as HTMLInputElement).value).toBe("Find flights to Lisbon");
  });

  it("History lists the last 30 days and shows a task's log, in the page's place", async () => {
    renderOn("browser-task-normal");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await flush();
    const history = screen.getByRole("region", { name: "Browser task history" });
    expect(screen.queryByRole("region", { name: "Page" })).toBeNull();
    const items = within(within(history).getByRole("list", { name: "Tasks" })).getAllByRole("button");
    expect(items).toHaveLength(4);
    fireEvent.click(items[2]!);
    await flush();
    const log = within(history).getByLabelText("Task log");
    expect(log.textContent).toContain("Renewed until 19 Oct 2027");
    expect(log.textContent).toContain("Matthew approved: OK to click ‘Pay £45’");
    expect(log.textContent).toContain("permits.example");
    fireEvent.click(within(history).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("region", { name: "Page" })).toBeTruthy();
  });
});

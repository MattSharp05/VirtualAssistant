import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent } from "@jarvis/shared";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { MockBridge } from "../../mock/bridge";
import CommandBar from "./index";
import { NOTION_DEBOUNCE_MS } from "./useSources";

function renderBar(scenario = "commandbar", setup?: (bridge: MockBridge) => void) {
  const choice = chooseBridge(`?scenario=${scenario}`, undefined);
  const bridge = choice.bridge as MockBridge;
  setup?.(bridge);
  const opened: [string, Record<string, string> | undefined][] = [];
  bridge.openWindow = (id, params) => void opened.push([id, params]);
  const chats: DeskEvent[] = [];
  bridge.subscribe((e) => e.type === "brain.start" && chats.push(e));
  render(
    <BridgeProvider value={choice}>
      <CommandBar />
    </BridgeProvider>,
  );
  return {
    bridge,
    opened,
    chats,
    input: screen.getByRole("combobox", { name: "Ask JARVIS or open a window" }),
  };
}

const options = () => screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"));

async function type(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  await act(async () => void (await vi.advanceTimersByTimeAsync(NOTION_DEBOUNCE_MS + 10)));
}

describe("Command bar", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("lists session mk first for “mk”, then the Notion page, then Ask JARVIS", async () => {
    vi.useFakeTimers();
    const { input } = renderBar();
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await type(input, "mk");
    expect(options()).toEqual([
      "Open session mk (Mario Kart orchestrator)",
      "Open session mk-80-builder (MK-80 track hazards)",
      "Notion: Mario Kart PRD",
      "Notion: Mario Kart · Technical design",
      "Ask JARVIS: “mk”",
    ]);
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("↵ opens the highlighted session and closes the bar; ↓ moves the highlight", async () => {
    vi.useFakeTimers();
    const { bridge, opened, input } = renderBar();
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await type(input, "mk");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened).toEqual([["sessions", { id: "mk" }]]);
    expect(bridge.frameActions).toEqual(["close"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened.at(-1)).toEqual(["notion", { page: "page-mk-prd" }]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true }).getAttribute("aria-label")).toBe(
      "Ask JARVIS: “mk”",
    );
  });

  it("⌘↵ asks JARVIS on the desk-typed channel, then closes", async () => {
    const { bridge, chats, input } = renderBar();
    fireEvent.change(input, { target: { value: "mk" } });
    await act(async () => void fireEvent.keyDown(input, { key: "Enter", metaKey: true }));
    await vi.waitFor(() => expect(chats).toHaveLength(1));
    expect(chats[0]).toMatchObject({ type: "brain.start", channel: "desk-typed", text: "mk" });
    expect(bridge.frameActions).toEqual(["close"]);
  });

  it("opens a window, a layout's windows, and closes on Esc", async () => {
    const { bridge, opened, input } = renderBar();
    fireEvent.change(input, { target: { value: "today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened).toEqual([["today", undefined]]);
    fireEvent.change(input, { target: { value: "work mode" } });
    await screen.findByRole("option", { name: "Layout: Work mode" });
    fireEvent.click(screen.getByRole("option", { name: "Layout: Work mode" }));
    expect(opened.slice(1).map(([id]) => id)).toEqual(["chat", "sessions", "today"]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(bridge.frameActions).toEqual(["close", "close", "close"]);
  });

  it("in the app, lists every layout (built-ins too) and applies one by name (JD-37)", async () => {
    const applied: string[] = [];
    const { opened, input } = renderBar("commandbar", (b) => {
      b.layouts = {
        list: async () => [
          { name: "Work mode", windows: ["sessions", "today", "chat", "todo"] },
          { name: "Focus", windows: [] },
        ],
        apply: async (name) => void applied.push(name),
      };
    });
    fireEvent.change(input, { target: { value: "focus" } });
    fireEvent.click(await screen.findByRole("option", { name: "Layout: Focus" }));
    expect(applied).toEqual(["Focus"]);
    expect(opened).toEqual([]);
  });

  it("still works when sessions and Notion search aren't on the server yet", async () => {
    vi.useFakeTimers();
    const { input } = renderBar("empty");
    await type(input, "mk");
    expect(options()).toEqual(["Ask JARVIS: “mk”"]);
  });

  it("says so when JARVIS can't be reached, and stays open", async () => {
    const { bridge, input } = renderBar();
    bridge.chat = () => Promise.reject(new Error("offline"));
    fireEvent.change(input, { target: { value: "hello?" } });
    await act(async () => void fireEvent.keyDown(input, { key: "Enter", metaKey: true }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach JARVIS: offline");
    expect(bridge.frameActions).toEqual([]);
  });
});

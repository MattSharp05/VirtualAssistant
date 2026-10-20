import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistoryResponse, DeskBridge } from "@jarvis/shared";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import Chat from "./index";

const flush = () => act(async () => void (await Promise.resolve()));

function mount(bridge: DeskBridge) {
  render(
    <BridgeProvider value={{ bridge }}>
      <Chat />
    </BridgeProvider>,
  );
}

describe("Chat window", () => {
  let bridge: MockBridge;
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = createMockBridge(findScenario("chat")!);
  });
  afterEach(() => {
    bridge.close();
    cleanup();
    vi.useRealTimers();
  });

  it("renders history with channel tags, step chips, metrics and today's totals", async () => {
    mount(bridge);
    await flush();
    expect(screen.getByText("what did I miss on Slack this morning?")).toBeTruthy();
    expect(screen.getByText(/🎙 voice · /)).toBeTruthy();
    expect(screen.getByText(/⌨ typed · /)).toBeTruthy();
    expect(screen.getByText(/Telegram · /)).toBeTruthy();
    expect(screen.getByText("slack search public")).toBeTruthy();
    expect(screen.getByText(/⏱ 5.1s · 🔢 21k in \(18k cached\) · 96 out · sonnet · 3 steps/)).toBeTruthy();
    expect(screen.getByTestId("chat-today").textContent).toBe(
      "Today: 14 replies · 182k in · 3.1k out · avg 4.8s",
    );
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe(
      "claude-sonnet-5-5",
    );
    expect((screen.getByRole("button", { name: "Push to talk" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the calendar change's Undo asks JARVIS to undo it", async () => {
    mount(bridge);
    await flush();
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole("button", { name: /^Undo: Moved Booking call/ }));
    await flush();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByText("undo that")).toBeTruthy();
  });

  it("the mic calls voice.pushToTalk when voice is there", async () => {
    const pushToTalk = vi.fn();
    mount({ ...bridge, voice: { pushToTalk } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Push to talk" }));
    expect(pushToTalk).toHaveBeenCalledOnce();
  });

  it("asks for an earlier page when there is one and puts it on top", async () => {
    const page = (texts: string[], hasMore: boolean): ChatHistoryResponse => ({
      ...(findScenario("chat")!.data["/chat/history?limit=50"] as ChatHistoryResponse),
      hasMore,
      messages: texts.map((text, i) => ({
        at: `2026-10-14T0${i + 1}:00:00Z`,
        from: "you",
        channel: "dashboard",
        text,
      })),
    });
    const paths: string[] = [];
    const paged: DeskBridge = {
      ...bridge,
      request: async <T,>(path: string) => {
        paths.push(path);
        return (path.includes("before=") ? page(["older"], false) : page(["newer"], true)) as T;
      },
    };
    mount(paged);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    await flush();
    expect(paths[1]).toBe(`/chat/history?before=${encodeURIComponent("2026-10-14T01:00:00Z")}&limit=50`);
    const texts = [...document.querySelectorAll(".chat-bubble")].map((b) => b.textContent);
    expect(texts).toEqual(["older", "newer"]);
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
  });

  describe("multi-line compose (JD-70)", () => {
    const box = () => screen.getByRole("textbox", { name: "Message JARVIS" }) as HTMLTextAreaElement;

    it("is a textarea with the keys hint beside today's totals", async () => {
      mount(bridge);
      await flush();
      expect(box().tagName).toBe("TEXTAREA");
      expect(box().rows).toBe(1);
      expect(screen.getByText("↵ send · ⇧↵ new line")).toBeTruthy();
    });

    it("Enter sends the draft and clears the box", async () => {
      mount(bridge);
      await flush();
      fireEvent.change(box(), { target: { value: "hello there" } });
      const enter = fireEvent.keyDown(box(), { key: "Enter" });
      await flush();
      expect(enter).toBe(false); // default prevented: no stray newline
      expect(bridge.chats.map((c) => c.text)).toEqual(["hello there"]);
      expect(box().value).toBe("");
      expect(screen.getByText("hello there")).toBeTruthy();
    });

    it("Shift+Enter doesn't send, and line breaks reach the log", async () => {
      mount(bridge);
      await flush();
      fireEvent.change(box(), { target: { value: "first line" } });
      const shiftEnter = fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
      expect(shiftEnter).toBe(true); // left to the browser, which inserts the newline
      expect(bridge.chats).toEqual([]);
      fireEvent.change(box(), { target: { value: "first line\nsecond line" } });
      fireEvent.keyDown(box(), { key: "Enter" });
      await flush();
      expect(bridge.chats.map((c) => c.text)).toEqual(["first line\nsecond line"]);
      const bubbles = [...document.querySelectorAll(".chat-msg-mine .chat-bubble")];
      expect(bubbles.at(-1)?.textContent).toBe("first line\nsecond line");
    });

    it("Enter that ends an IME composition doesn't send", async () => {
      mount(bridge);
      await flush();
      fireEvent.change(box(), { target: { value: "にほんご" } });
      fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
      fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
      await flush();
      expect(bridge.chats).toEqual([]);
      expect(box().value).toBe("にほんご");
    });

    it("Enter on a blank draft sends nothing", async () => {
      mount(bridge);
      await flush();
      fireEvent.change(box(), { target: { value: "   " } });
      fireEvent.keyDown(box(), { key: "Enter" });
      await flush();
      expect(bridge.chats).toEqual([]);
    });
  });
});

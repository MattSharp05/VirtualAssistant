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

  describe("markdown in JARVIS's replies (JD-79)", () => {
    const history = (messages: ChatHistoryResponse["messages"]): ChatHistoryResponse => ({
      ...(findScenario("chat")!.data["/chat/history?limit=50"] as ChatHistoryResponse),
      hasMore: false,
      messages,
    });
    const at = "2026-10-14T09:00:00Z";
    const withHistory = (messages: ChatHistoryResponse["messages"]): DeskBridge => ({
      ...bridge,
      request: async <T,>() => history(messages) as T,
    });
    const jarvisBubble = () => document.querySelector(".chat-msg-jarvis .chat-bubble")!;

    it("renders bold, code and a web link as real elements", async () => {
      mount(
        withHistory([
          {
            at,
            from: "jarvis",
            channel: "desk-typed",
            text: "It's **done**. Run `npm test`, then see [the PR](https://example.com).",
          },
        ]),
      );
      await flush();
      const bubble = jarvisBubble();
      expect(bubble.querySelector("strong")?.textContent).toBe("done");
      expect(bubble.querySelector("code")?.textContent).toBe("npm test");
      const link = screen.getByRole("link", { name: "the PR" });
      expect(link.getAttribute("href")).toBe("https://example.com");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
      expect(bubble.textContent).toBe("It's done. Run npm test, then see the PR.");
    });

    it("leaves a reply without markdown exactly as it was, line breaks included", async () => {
      const text = "Two things.\nSam asked about Friday (14:00) and Alex shared a logo. Nothing urgent.";
      mount(withHistory([{ at, from: "jarvis", channel: "telegram", text }]));
      await flush();
      const bubble = jarvisBubble();
      expect(bubble.textContent).toBe(text);
      expect(bubble.querySelectorAll("strong, em, code, a, ul")).toHaveLength(0);
    });

    it("only formats web and mail links", async () => {
      mount(
        withHistory([
          {
            at,
            from: "jarvis",
            channel: "desk-typed",
            text: "[mail](mailto:sam@example.com) and [bad](javascript:alert(1))",
          },
        ]),
      );
      await flush();
      const links = jarvisBubble().querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute("href")).toBe("mailto:sam@example.com");
      expect(jarvisBubble().textContent).toContain("bad");
    });

    it("keeps what Matthew typed as plain text", async () => {
      mount(
        withHistory([
          { at, from: "you", channel: "desk-typed", text: "this is **not markdown** [x](https://a.b)" },
        ]),
      );
      await flush();
      const bubble = document.querySelector(".chat-msg-mine .chat-bubble")!;
      expect(bubble.textContent).toBe("this is **not markdown** [x](https://a.b)");
      expect(bubble.querySelectorAll("strong, a")).toHaveLength(0);
    });

    it("streams partial markdown as text and formats it once the marker closes", async () => {
      let listener: Parameters<DeskBridge["subscribe"]>[0] = () => {};
      mount({
        ...withHistory([]),
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
      });
      await flush();
      const send = (event: Parameters<typeof listener>[0]) => act(() => listener(event));
      send({ type: "brain.start", messageId: "m1", channel: "telegram", text: "hi" });
      const chunks = ["See **bo", "ld** and [the ", "PR](https://exa", "mple.com) or `np", "m test`."];
      for (const chunk of chunks) {
        send({ type: "brain.delta", messageId: "m1", text: chunk });
        // Never throws, and nothing is lost while a marker is still open.
        expect(jarvisBubble().textContent!.length).toBeGreaterThan(0);
      }
      const bubble = jarvisBubble();
      expect(bubble.querySelector("strong")?.textContent).toBe("bold");
      expect(bubble.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
      expect(bubble.querySelector("code")?.textContent).toBe("npm test");
      expect(bubble.querySelector(".chat-caret")).toBeTruthy();
    });

    it("shows an unclosed marker mid-stream as plain text", async () => {
      let listener: Parameters<DeskBridge["subscribe"]>[0] = () => {};
      mount({
        ...withHistory([]),
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
      });
      await flush();
      act(() => listener({ type: "brain.start", messageId: "m1", channel: "telegram", text: "hi" }));
      act(() => listener({ type: "brain.delta", messageId: "m1", text: "See **bol" }));
      expect(jarvisBubble().textContent).toBe("See **bol");
      expect(jarvisBubble().querySelector("strong")).toBeNull();
      act(() => listener({ type: "brain.delta", messageId: "m1", text: "d**" }));
      expect(jarvisBubble().querySelector("strong")?.textContent).toBe("bold");
    });
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

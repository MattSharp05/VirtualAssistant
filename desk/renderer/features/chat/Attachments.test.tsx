import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../../app/bridge";
import { createMockBridge, type MockBridge } from "../../mock/bridge";
import { findScenario } from "../../mock/scenarios";
import Chat from "./index";

const files = (...list: File[]) => ({ dataTransfer: { types: ["Files"], files: list, dropEffect: "none" } });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("Chat window: dropped files (JD-40)", () => {
  let bridge: MockBridge;
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = createMockBridge(findScenario("filedrop")!);
    render(
      <BridgeProvider value={{ bridge }}>
        <Chat />
      </BridgeProvider>,
    );
  });
  afterEach(() => {
    bridge.close();
    cleanup();
    vi.useRealTimers();
  });

  const log = () => screen.getByRole("log", { name: "Conversation" });
  const input = () => screen.getByRole("textbox", { name: "Message JARVIS" });

  it("attaches a dropped file to the next message as a chip, then sends it along", async () => {
    fireEvent.dragEnter(log(), files());
    expect(screen.getByText("Drop to attach to your next message")).toBeTruthy();
    fireEvent.drop(log(), files(new File(["%PDF"], "q3.pdf")));
    expect(screen.queryByText("Drop to attach to your next message")).toBeNull();
    const chips = screen.getByRole("list", { name: "Attached to your next message" });
    expect(chips.textContent).toContain("q3.pdf");
    fireEvent.change(input(), { target: { value: "what's the ask?" } });
    // Send waits for the upload.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    await tick(500);
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.chats).toEqual([
      { text: "what's the ask?", channel: "desk-typed", attachments: ["upload-1"] },
    ]);
    expect(screen.queryByRole("list", { name: "Attached to your next message" })).toBeNull();
    expect(screen.getByRole("list", { name: "Files sent" }).textContent).toBe("q3.pdf");
  });

  it("a chip can be taken off before sending", async () => {
    fireEvent.drop(log(), files(new File(["a"], "a.txt")));
    await tick(500);
    fireEvent.click(screen.getByRole("button", { name: "Remove a.txt" }));
    fireEvent.change(input(), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.chats).toEqual([{ text: "hi", channel: "desk-typed" }]);
  });

  it("turns away files it can't take, with a message", () => {
    const big = new File(["x"], "big.pdf");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 });
    fireEvent.drop(log(), files(big));
    expect(screen.getByRole("alert").textContent).toBe("big.pdf is 25 MB: files can be up to 20 MB.");
    fireEvent.drop(log(), files(new File(["x"], "setup.dmg")));
    expect(screen.getByRole("alert").textContent).toMatch(/can't read \.dmg files/);
    expect(bridge.requests.some((r) => r.path === "/files")).toBe(false);
  });
});

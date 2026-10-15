import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { MockBridge } from "../../mock/bridge";
import CommandBar from "./index";

describe("Command bar opened from a dropped file (JD-40)", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("starts with the question and sends the file with it", async () => {
    window.history.replaceState(null, "", "/?ask=About%20q3.pdf%3A%20&attach=upload-1&file=q3.pdf");
    const choice = chooseBridge("?scenario=filedrop", undefined);
    const bridge = choice.bridge as MockBridge;
    render(
      <BridgeProvider value={choice}>
        <CommandBar />
      </BridgeProvider>,
    );
    const input = screen.getByRole("combobox", { name: "Ask JARVIS or open a window" }) as HTMLInputElement;
    expect(input.value).toBe("About q3.pdf: ");
    expect(input.selectionStart).toBe(input.value.length);
    expect(screen.getByText("q3.pdf", { selector: ".commandbar-file" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "About q3.pdf: what's the ask?" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await Promise.resolve();
    expect(bridge.chats).toEqual([
      { text: "About q3.pdf: what's the ask?", channel: "desk-typed", attachments: ["upload-1"] },
    ]);
    bridge.close();
  });
});

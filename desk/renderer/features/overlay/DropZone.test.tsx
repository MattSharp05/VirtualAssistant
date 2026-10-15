import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { MockBridge } from "../../mock/bridge";
import { REJECTED_MS } from "./DropZone";
import { Overlay } from "./Overlay";

const MB = 1024 * 1024;

/** jsdom has no DataTransfer; testing-library puts this object on the event instead. */
const files = (...list: File[]) => ({ dataTransfer: { types: ["Files"], files: list, dropEffect: "none" } });

/** A File that says it's this big without holding the bytes. */
function sized(name: string, size: number): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function renderOverlay() {
  const choice = chooseBridge("?scenario=filedrop", undefined);
  render(
    <BridgeProvider value={choice}>
      <Overlay />
    </BridgeProvider>,
  );
  return { bridge: choice.bridge as MockBridge, orb: () => screen.getByRole("button", { name: /JARVIS/ }) };
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("file drop on the orb (JD-40)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the drop ring while a file is over the overlay and takes the mouse", () => {
    const { bridge, orb } = renderOverlay();
    fireEvent.dragEnter(orb(), files());
    expect(document.querySelector(".drop-ring")).not.toBeNull();
    expect(bridge.interactive).toBe(true);
    fireEvent.dragLeave(orb(), files());
    expect(document.querySelector(".drop-ring")).toBeNull();
    expect(bridge.interactive).toBe(false);
    // Text dragged out of a page isn't a file.
    fireEvent.dragEnter(orb(), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(document.querySelector(".drop-ring")).toBeNull();
  });

  it("uploads a dropped file with progress, asks what to do, and Summarise sends it to chat", async () => {
    const { bridge, orb } = renderOverlay();
    fireEvent.dragEnter(orb(), files());
    fireEvent.drop(orb(), files(new File(["%PDF"], "q3.pdf", { type: "application/pdf" })));
    expect(document.querySelector(".drop-ring")).toBeNull();
    await tick(160);
    const bar = screen.getByRole("progressbar", { name: "Uploading q3.pdf" });
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    await tick(320);
    expect(screen.getByText(/What should I do with it\?/).textContent).toBe(
      "Got q3.pdf. What should I do with it?",
    );
    expect(bridge.requests).toContainEqual({
      path: "/files",
      body: { name: "q3.pdf", size: 4, type: "application/pdf" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Summarise" }));
    expect(bridge.chats).toEqual([
      { text: "Summarise q3.pdf.", channel: "desk-typed", attachments: ["upload-1"] },
    ]);
    expect(screen.queryByRole("article", { name: "Dropped file" })).toBeNull();
  });

  it("speaks the summary when voice is set up", async () => {
    const { bridge, orb } = renderOverlay();
    bridge.voice = { pushToTalk: () => {} };
    fireEvent.drop(orb(), files(new File(["hi"], "notes.md")));
    await tick(500);
    fireEvent.click(screen.getByRole("button", { name: "Summarise" }));
    expect(bridge.chats[0]).toMatchObject({ channel: "desk-voice", attachments: ["upload-1"] });
  });

  it("Ask… opens the command bar prefilled with the file", async () => {
    const { bridge, orb } = renderOverlay();
    const opened: [string, Record<string, string> | undefined][] = [];
    bridge.openWindow = (id, params) => void opened.push([id, params]);
    fireEvent.drop(orb(), files(new File(["png"], "screen.png")));
    await tick(500);
    fireEvent.click(screen.getByRole("button", { name: "Ask…" }));
    expect(opened).toEqual([
      ["commandbar", { ask: "About screen.png: ", attach: "upload-1", file: "screen.png" }],
    ]);
  });

  it("turns away a 25 MB file without uploading, and the message leaves by itself", async () => {
    const { bridge, orb } = renderOverlay();
    fireEvent.drop(orb(), files(sized("big.pdf", 25 * MB)));
    expect(screen.getByRole("alert").textContent).toBe("big.pdf is 25 MB: files can be up to 20 MB.");
    expect(bridge.requests.filter((r) => r.path === "/files")).toEqual([]);
    await tick(REJECTED_MS);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the card can be dismissed", async () => {
    const { orb } = renderOverlay();
    fireEvent.drop(orb(), files(new File(["a"], "a.txt")));
    await tick(500);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss file" }));
    expect(screen.queryByText(/What should I do/)).toBeNull();
  });
});

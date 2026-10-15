// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DeskEvent, RpcAnswer, UploadResponse } from "@jarvis/shared";
import type { UploadSource } from "../uploads";
import { ClipboardReader, CLIPBOARD_CARD_ID } from "./clipboard";
import { answerRpc } from "./index";
import {
  LOOK_CARD_MS,
  lookCard,
  SCREEN_CARD_ID,
  ScreenLook,
  shotName,
  shotSize,
  type Display,
  type ScreenAccess,
  type ScreenDeps,
} from "./screen";

const at = new Date(2026, 9, 15, 9, 12, 5);
const retina: Display = { id: 7, size: { width: 1512, height: 982 }, scaleFactor: 2 };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);

function fakeScreen(over: Partial<ScreenDeps> = {}) {
  const log: string[] = [];
  const events: DeskEvent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const uploads: UploadSource[] = [];
  const deps: ScreenDeps = {
    pointerDisplay: () => retina,
    access: () => "granted",
    hideOverlay: async () => {
      log.push("hide");
      return () => log.push("show");
    },
    capture: async (display, size) => {
      log.push(`capture ${display.id} ${size.width}x${size.height}`);
      return jpeg;
    },
    upload: async (source) => {
      log.push("upload");
      uploads.push(source);
      return { id: "abc123abc123", path: "/data/uploads/abc123abc123/x.jpg", name: source.name };
    },
    publish: (e) => {
      log.push(e.type);
      events.push(e);
    },
    now: () => at,
    wait: async () => {},
    later: (fn, ms) => void timers.push({ fn, ms }),
    ...over,
  };
  return { look: new ScreenLook(deps), log, events, timers, uploads };
}

describe("shotSize / shotName", () => {
  it("uses the display's real pixels, scaled so the longest side is at most 2560", () => {
    expect(shotSize({ id: 1, size: { width: 1280, height: 800 }, scaleFactor: 1 })).toEqual({
      width: 1280,
      height: 800,
    });
    expect(shotSize(retina)).toEqual({ width: 2560, height: 1663 });
    expect(shotSize({ id: 1, size: { width: 1080, height: 1920 }, scaleFactor: 2 }).height).toBe(2560);
  });

  it("names the shot by the time it was taken", () => {
    expect(shotName(at)).toBe("screen-2026-10-15-091205.jpg");
  });
});

describe("ScreenLook", () => {
  it("hides the overlay for the shot, puts it back, shows the card, then uploads", async () => {
    const { look, log, events, timers, uploads } = fakeScreen();
    const out = await look.capture();
    expect(log).toEqual(["hide", "capture 7 2560x1663", "show", "card.show", "upload"]);
    expect(out).toEqual({
      upload: {
        id: "abc123abc123",
        path: "/data/uploads/abc123abc123/x.jpg",
        name: "screen-2026-10-15-091205.jpg",
      },
      width: 1512,
      height: 982,
    });
    expect(uploads[0]!.bytes).toBe(jpeg);
    expect(events[0]).toEqual({ type: "card.show", card: lookCard(at) });
    expect((events[0] as { card: { title: string } }).card.title).toBe("📸 Looked at your screen");
    // The card is brief: it goes by itself a few seconds later.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(LOOK_CARD_MS);
    timers[0]!.fn();
    expect(events[1]).toEqual({ type: "card.dismiss", id: SCREEN_CARD_ID });
  });

  it("puts the overlay back even when the capture fails", async () => {
    const { look, log, events } = fakeScreen({
      capture: async () => {
        throw new Error("capture failed");
      },
    });
    await expect(look.capture()).rejects.toThrow("capture failed");
    expect(log).toEqual(["hide", "show"]);
    expect(events).toEqual([]);
  });

  it.each<ScreenAccess>(["denied", "restricted"])(
    "refuses without Screen Recording (%s) and says where to allow it",
    async (access) => {
      const { look, log } = fakeScreen({ access: () => access });
      await expect(look.capture()).rejects.toThrow(/Privacy & Security → Screen Recording/);
      expect(log).toEqual([]);
    },
  );

  it("tries when macOS hasn't asked yet, and explains an empty picture", async () => {
    const { look, log } = fakeScreen({ access: () => "not-determined", capture: async () => undefined });
    await expect(look.capture()).rejects.toThrow(/came back empty/);
    expect(log).toEqual(["hide", "show"]);
  });
});

function fakeClipboard(text: string, image?: Uint8Array) {
  const events: DeskEvent[] = [];
  const timers: (() => void)[] = [];
  const upload = vi.fn(async (s: UploadSource): Promise<UploadResponse> => ({
    id: "fedcba987654",
    path: "/u/clipboard.png",
    name: s.name,
  }));
  const reader = new ClipboardReader({
    readText: async () => text,
    readImage: async () => image,
    upload,
    publish: (e) => events.push(e),
    now: () => at,
    later: (fn) => void timers.push(fn),
  });
  return { reader, events, timers, upload };
}

describe("ClipboardReader", () => {
  it("returns text as is, with a brief card", async () => {
    const { reader, events, timers, upload } = fakeClipboard("teh quick brown fox", jpeg);
    expect(await reader.read()).toEqual({ kind: "text", text: "teh quick brown fox", truncated: false });
    expect(upload).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: "card.show",
      card: { id: CLIPBOARD_CARD_ID, title: "📋 Read your clipboard" },
    });
    timers[0]!();
    expect(events[1]).toEqual({ type: "card.dismiss", id: CLIPBOARD_CARD_ID });
  });

  it("cuts text at 20k characters and says so", async () => {
    const { reader } = fakeClipboard("x".repeat(20_005));
    const out = await reader.read();
    expect(out).toMatchObject({ kind: "text", truncated: true });
    expect((out as { text: string }).text).toHaveLength(20_000);
  });

  it("uploads an image as PNG", async () => {
    const png = new Uint8Array([0x89, 0x50]);
    const { reader, upload } = fakeClipboard("", png);
    expect(await reader.read()).toEqual({
      kind: "image",
      upload: { id: "fedcba987654", path: "/u/clipboard.png", name: "clipboard.png" },
    });
    expect(upload).toHaveBeenCalledWith({ name: "clipboard.png", bytes: png });
  });

  it("an empty clipboard is empty, with no card", async () => {
    const { reader, events } = fakeClipboard("  \n");
    expect(await reader.read()).toEqual({ kind: "empty" });
    expect(events).toEqual([]);
  });
});

describe("as rpc handlers", () => {
  it("answers screen.capture with the upload, and a refusal as an error", async () => {
    const send = vi.fn<(path: string, answer: RpcAnswer) => Promise<unknown>>(async () => ({ ok: true }));
    const { look } = fakeScreen();
    await answerRpc(
      { type: "rpc", id: "s1", kind: "screen.capture", payload: {} },
      { "screen.capture": () => look.capture() },
      send,
    );
    expect(send.mock.lastCall?.[1]).toMatchObject({ ok: true, result: { width: 1512, height: 982 } });
    const denied = fakeScreen({ access: () => "denied" }).look;
    await answerRpc(
      { type: "rpc", id: "s2", kind: "screen.capture", payload: {} },
      { "screen.capture": () => denied.capture() },
      send,
    );
    expect(send.mock.lastCall?.[1]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Screen Recording/),
    });
  });
});

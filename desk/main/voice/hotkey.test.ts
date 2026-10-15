// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHotkey, PttDetector, pttKeyCode, RIGHT_ALT, type PttSignal, type UiohookLike } from "./hotkey";
import type { PttKey } from "../settingsSchema";

const E = 18; // the E key: any other key
const LEFT_ALT = 56;

/** A detector on a fake clock and timers; `at(ms)` moves the clock (firing due timers). */
function setup(key: PttKey = "RightAlt-double") {
  let clock = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  const signals: PttSignal[] = [];
  const detector = new PttDetector(key, (s) => signals.push(s), {
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ at: clock + ms, fn, id: ++nextId });
      return nextId;
    },
    clearTimer: (id) => void (timers = timers.filter((t) => t.id !== id)),
  });
  const at = (ms: number) => {
    clock = ms;
    for (const t of timers.filter((t) => t.at <= ms)) {
      timers = timers.filter((x) => x !== t);
      t.fn();
    }
  };
  const tap = (code: number, down: number, up = down + 60) => {
    at(down);
    detector.keyDown(code);
    at(up);
    detector.keyUp(code);
  };
  return { detector, signals, at, tap };
}

describe("double-tap right ⌥", () => {
  it("two taps within 350 ms fire once", () => {
    const { signals, tap } = setup();
    tap(RIGHT_ALT, 0);
    tap(RIGHT_ALT, 200);
    expect(signals).toEqual(["toggle"]);
    // A third quick tap is a new first tap, not another double.
    tap(RIGHT_ALT, 400);
    expect(signals).toEqual(["toggle"]);
    tap(RIGHT_ALT, 650);
    expect(signals).toEqual(["toggle", "toggle"]);
  });

  it("taps too far apart don't fire", () => {
    const { signals, tap } = setup();
    tap(RIGHT_ALT, 0);
    tap(RIGHT_ALT, 351);
    expect(signals).toEqual([]);
  });

  it("a tap + another key + a tap doesn't fire", () => {
    const { signals, tap } = setup();
    tap(RIGHT_ALT, 0);
    tap(E, 80, 120);
    tap(RIGHT_ALT, 200);
    expect(signals).toEqual([]);
  });

  it("holding doesn't fire (auto-repeat or a long press)", () => {
    const { detector, signals, at, tap } = setup();
    at(0);
    detector.keyDown(RIGHT_ALT);
    for (const t of [100, 200, 300]) {
      at(t);
      detector.keyDown(RIGHT_ALT); // repeats while held
    }
    at(2000);
    detector.keyUp(RIGHT_ALT);
    expect(signals).toEqual([]);
    tap(RIGHT_ALT, 2400, 3000); // pressed again, then held
    expect(signals).toEqual([]);
  });

  it("left ⌥ isn't right ⌥", () => {
    const { signals, tap } = setup();
    tap(LEFT_ALT, 0);
    tap(LEFT_ALT, 150);
    expect(signals).toEqual([]);
  });
});

describe("hold right ⌥", () => {
  it("starts after a short hold and ends on release", () => {
    const { detector, signals, at } = setup("RightAlt-hold");
    at(0);
    detector.keyDown(RIGHT_ALT);
    at(249);
    expect(signals).toEqual([]);
    at(250);
    expect(signals).toEqual(["hold-start"]);
    at(1800);
    detector.keyUp(RIGHT_ALT);
    expect(signals).toEqual(["hold-start", "hold-end"]);
  });

  it("a quick ⌥ press, or ⌥ as a modifier, never starts; another key mid-hold cancels", () => {
    const { detector, signals, at, tap } = setup("RightAlt-hold");
    tap(RIGHT_ALT, 0, 100);
    at(0 + 1000);
    detector.keyDown(RIGHT_ALT);
    at(1100);
    detector.keyDown(E); // ⌥E
    at(1500);
    detector.keyUp(RIGHT_ALT);
    expect(signals).toEqual([]);
    at(2000);
    detector.keyDown(RIGHT_ALT);
    at(2400);
    detector.keyDown(E);
    expect(signals).toEqual(["hold-start", "hold-cancel"]);
    at(2600);
    detector.keyUp(RIGHT_ALT);
    expect(signals).toEqual(["hold-start", "hold-cancel"]);
  });
});

describe("a function key", () => {
  it("each press toggles; repeats don't", () => {
    const { detector, signals, at, tap } = setup("F13");
    at(0);
    detector.keyDown(pttKeyCode("F13")!);
    detector.keyDown(pttKeyCode("F13")!);
    detector.keyUp(pttKeyCode("F13")!);
    tap(pttKeyCode("F12")!, 100);
    tap(RIGHT_ALT, 200);
    tap(RIGHT_ALT, 300);
    expect(signals).toEqual(["toggle"]);
  });

  it("follows the setting when it changes", () => {
    const { detector, signals, tap } = setup("F13");
    detector.setKey("RightAlt-double");
    tap(pttKeyCode("F13")!, 0);
    tap(RIGHT_ALT, 100);
    tap(RIGHT_ALT, 200);
    expect(signals).toEqual(["toggle"]);
    expect(pttKeyCode("F20")).toBe(103);
    expect(pttKeyCode("F99")).toBeUndefined();
  });
});

it("createHotkey feeds the hook's key codes to the detector and starts once", () => {
  const handlers: Record<string, (e: { keycode: number }) => void> = {};
  let starts = 0;
  let stops = 0;
  const hook: UiohookLike = {
    on: (event, fn) => (handlers[event] = fn),
    start: () => void starts++,
    stop: () => void stops++,
  };
  const signals: PttSignal[] = [];
  const hotkey = createHotkey("F13", (s) => signals.push(s), hook);
  hotkey.start();
  hotkey.start();
  handlers.keydown!({ keycode: 91 });
  handlers.keyup!({ keycode: 91 });
  expect(signals).toEqual(["toggle"]);
  expect(starts).toBe(1);
  hotkey.stop();
  hotkey.stop();
  expect(stops).toBe(1);
});

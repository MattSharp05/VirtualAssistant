// The push-to-talk key (ADR 0004): uiohook-napi sees key-downs and key-ups from every app (it needs
// macOS's Input Monitoring / Accessibility, permissions.ts), and PttDetector turns the push-to-talk key's
// presses into signals. Only key codes reach the detector, and it remembers nothing but the push-to-talk
// key's last press: other keys are ignored, never stored or logged. Settings → pttKey picks the gesture:
// double-tap right Option (the default), hold right Option, or a function key. uiohook-napi is native:
// loaded lazily (external to the bundle) so the detector tests without it.
import type { PttKey } from "../settingsSchema";

/** toggle: start listening, or cancel when already listening. hold-*: hold right Option to talk. */
export type PttSignal = "toggle" | "hold-start" | "hold-end" | "hold-cancel";

/** Two presses at most this far apart are a double tap. */
export const DOUBLE_TAP_MS = 350;
/** Right Option held this long (with no other key) starts hold-to-talk; shorter is a plain ⌥ press. */
export const HOLD_MS = 250;

/** libuiohook's key codes (uiohook-napi's UiohookKey), copied so the detector loads without the addon. */
export const RIGHT_ALT = 3640;
const F_KEYS: Record<string, number> = {
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102, F20: 103,
}; // prettier-ignore

/** The key code a setting listens to: right Option, or the function key (undefined for an unknown one). */
export function pttKeyCode(key: PttKey): number | undefined {
  return key.startsWith("RightAlt") ? RIGHT_ALT : F_KEYS[key];
}

export interface DetectorOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class PttDetector {
  private down = false;
  /** When the push-to-talk key was last pressed as a possible first tap. */
  private firstTapAt?: number;
  private holdTimer?: unknown;
  private holding = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private key: PttKey,
    private readonly emit: (signal: PttSignal) => void,
    opts: DetectorOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Settings → pttKey changed. */
  setKey(key: PttKey): void {
    this.reset();
    this.key = key;
  }

  keyDown(code: number): void {
    if (code !== pttKeyCode(this.key)) return this.otherKey();
    if (this.down) return; // auto-repeat while held
    this.down = true;
    if (this.key === "RightAlt-hold") {
      this.holdTimer = this.setTimer(() => {
        this.holdTimer = undefined;
        this.holding = true;
        this.emit("hold-start");
      }, HOLD_MS);
    } else if (this.key === "RightAlt-double") {
      const at = this.now();
      if (this.firstTapAt !== undefined && at - this.firstTapAt <= DOUBLE_TAP_MS) {
        this.firstTapAt = undefined;
        this.emit("toggle");
      } else this.firstTapAt = at;
    } else this.emit("toggle");
  }

  keyUp(code: number): void {
    if (code !== pttKeyCode(this.key)) return;
    this.down = false;
    this.cancelHoldTimer();
    if (this.holding) {
      this.holding = false;
      this.emit("hold-end");
    }
  }

  /** Any other key: ⌥ was a modifier (⌥E, ⌥←…), not push-to-talk. Which key it was isn't kept. */
  private otherKey(): void {
    this.firstTapAt = undefined;
    this.cancelHoldTimer();
    if (this.holding) {
      this.holding = false;
      this.emit("hold-cancel");
    }
  }

  private cancelHoldTimer(): void {
    if (this.holdTimer === undefined) return;
    this.clearTimer(this.holdTimer);
    this.holdTimer = undefined;
  }

  private reset(): void {
    this.cancelHoldTimer();
    this.down = false;
    this.holding = false;
    this.firstTapAt = undefined;
  }
}

/** The parts of uiohook-napi's uIOhook used here. */
export interface UiohookLike {
  on(event: "keydown" | "keyup", fn: (e: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

function loadUiohook(): UiohookLike {
  // require, not import(): the bundle is CommonJS and the addon sits in the (unpacked) asar.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("uiohook-napi") as { uIOhook: UiohookLike }).uIOhook;
}

export interface Hotkey {
  /** Starts the system-wide key hook; throws when macOS doesn't allow it yet (permissions.ts). */
  start(): void;
  setKey(key: PttKey): void;
  stop(): void;
}

export function createHotkey(key: PttKey, onSignal: (s: PttSignal) => void, hook?: UiohookLike): Hotkey {
  const detector = new PttDetector(key, onSignal);
  let io: UiohookLike | undefined;
  let running = false;
  return {
    start() {
      if (running) return;
      if (!io) {
        io = hook ?? loadUiohook();
        io.on("keydown", (e) => detector.keyDown(e.keycode));
        io.on("keyup", (e) => detector.keyUp(e.keycode));
      }
      io.start();
      running = true;
    },
    setKey: (k) => detector.setKey(k),
    stop() {
      if (running) io?.stop();
      running = false;
    },
  };
}

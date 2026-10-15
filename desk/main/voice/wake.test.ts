// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { FRAME_LENGTH, SharedMic, type Mic } from "../audio/recorder";
import {
  createPorcupine,
  falseTriggerEntry,
  isKeyError,
  PRE_ROLL_FRAMES,
  unpacked,
  WakeKeyError,
  WakeWord,
  wakeStatusLine,
  type PorcupineModule,
  type WakeConfig,
  type WakeDeps,
  type WakeEngine,
} from "./wake";

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Lets the wake loop read every frame the fake mic has queued. */
const settle = async () => {
  for (let i = 0; i < 60; i++) await tick();
};

/** Frame n is filled with n, so a test can tell frames apart. */
const frame = (n: number) => new Int16Array(FRAME_LENGTH).fill(n);

/**
 * A fake mic fed by hand (`feed`), behind a real SharedMic, and a fake Porcupine that hears "Jarvis"
 * in the frames listed in `detectAt`.
 */
function setup(over: Partial<WakeDeps> = {}, config: Partial<WakeConfig> = {}) {
  const log: string[] = [];
  const processed: number[] = [];
  const detectAt = new Set<number>();
  const queue: Int16Array[] = [];
  let waiting: ((f: Int16Array) => void) | undefined;
  const feed = (...ns: number[]) => {
    for (const n of ns) {
      const f = frame(n);
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w(f);
      } else queue.push(f);
    }
  };
  let opened = 0;
  const shared = new SharedMic(async (): Promise<Mic> => {
    opened++;
    log.push("mic open");
    return {
      read: () => {
        const next = queue.shift();
        return next ? Promise.resolve(next) : new Promise((r) => (waiting = r));
      },
      stop: () => void log.push("mic stop"),
    };
  });
  const cfg: WakeConfig = {
    enabled: true,
    accessKey: "pv-key-0123456789abcdefghij",
    sensitivity: 0.5,
    dnd: false,
    wakeDuringDnd: false,
    ...config,
  };
  const state = { busy: false };
  const wakes: Int16Array[][] = [];
  const engine: WakeEngine = {
    frameLength: FRAME_LENGTH,
    process: (f) => {
      processed.push(f[0]);
      return detectAt.has(f[0]) ? 0 : -1;
    },
    release: () => void log.push("engine release"),
  };
  const deps: WakeDeps = {
    config: () => cfg,
    createEngine: (key, sensitivity) => {
      log.push(`engine ${key.slice(0, 2)} ${sensitivity}`);
      return engine;
    },
    acquireMic: () => shared.acquire(),
    busy: () => state.busy,
    onWake: (preRoll) => {
      wakes.push(preRoll);
      state.busy = true; // push-to-talk starts listening
    },
    chime: () => void log.push("chime"),
    now: () => 5_000,
    ...over,
  };
  const wake = new WakeWord(deps);
  return { wake, log, processed, detectAt, feed, cfg, state, wakes, shared, opened: () => opened };
}

describe("WakeWord", () => {
  it("hears “Jarvis”, chimes, and starts listening with the last 500 ms of audio", async () => {
    const { wake, log, detectAt, feed, wakes } = setup();
    detectAt.add(30);
    wake.start();
    expect(wake.status).toBe("listening");
    feed(...Array.from({ length: 30 }, (_, i) => i + 1));
    await settle();
    expect(wakes).toHaveLength(1);
    // 16 frames × 32 ms = 512 ms: the frames up to and including the one "Jarvis" ended in.
    expect(PRE_ROLL_FRAMES).toBe(16);
    expect(wakes[0].map((f) => f[0])).toEqual(Array.from({ length: 16 }, (_, i) => i + 15));
    expect(log).toContain("chime");
    expect(wake.lastTrigger).toBe(5_000);
    // Push-to-talk took over: paused, and the mic is left running for the session.
    expect(wake.status).toBe("paused");
    expect(log).not.toContain("mic stop");
  });

  it("ignores a detection while JARVIS is speaking (never feeds the engine)", async () => {
    const { wake, detectAt, feed, wakes, processed, state, log } = setup();
    detectAt.add(3);
    wake.start();
    feed(1, 2);
    await settle();
    state.busy = true; // speaking (JD-38) or push-to-talk
    feed(3, 4);
    await settle();
    expect(wakes).toEqual([]);
    expect(processed).toEqual([1, 2]);
    wake.sync();
    expect(wake.status).toBe("paused");
    expect(log).toContain("mic stop");
  });

  it("resumes once push-to-talk is idle and nothing is speaking", async () => {
    const { wake, detectAt, feed, wakes, state } = setup();
    detectAt.add(2).add(9);
    wake.start();
    feed(1, 2);
    await settle();
    expect(wakes).toHaveLength(1);
    state.busy = false;
    wake.sync();
    expect(wake.status).toBe("listening");
    feed(8, 9);
    await settle();
    expect(wakes).toHaveLength(2);
    expect(wakes[1].map((f) => f[0])).toEqual([8, 9]);
  });

  it("stops processing when turned off, and releases the engine and the mic", async () => {
    const { wake, cfg, feed, processed, log } = setup();
    wake.start();
    feed(1);
    await settle();
    cfg.enabled = false;
    wake.sync();
    feed(2, 3);
    await settle();
    expect(processed).toEqual([1]);
    expect(wake.status).toBe("off");
    expect(log).toEqual(expect.arrayContaining(["engine release", "mic stop"]));
  });

  it("pauses during Do Not Disturb unless wakeDuringDnd", () => {
    const { wake, cfg } = setup({}, { dnd: true });
    wake.start();
    expect(wake.status).toBe("paused");
    cfg.wakeDuringDnd = true;
    wake.sync();
    expect(wake.status).toBe("listening");
  });

  it("needs a key: no key or a rejected one never opens the mic", () => {
    const missing = setup({}, { accessKey: undefined });
    missing.wake.start();
    expect(missing.wake.status).toBe("no-key");
    expect(missing.opened()).toBe(0);

    const rejected = setup({
      createEngine: () => {
        throw new WakeKeyError("no");
      },
    });
    rejected.wake.start();
    expect(rejected.wake.status).toBe("bad-key");
    expect(rejected.opened()).toBe(0);
    expect(wakeStatusLine("no-key")).toBe("Wake word: add Picovoice key in Settings");
    expect(wakeStatusLine("bad-key")).toBe("Wake word: add Picovoice key in Settings");
    expect(wakeStatusLine("listening")).toBeUndefined();
  });

  it("isn't started on its own (e.g. on a scenario), and stop() turns it off", () => {
    const { wake, log } = setup();
    wake.sync();
    expect(wake.status).toBe("off");
    expect(log).toEqual([]);
    wake.start();
    wake.stop();
    wake.sync();
    expect(wake.status).toBe("off");
  });

  it("reload() starts again from a new engine (a new key or sensitivity)", () => {
    const { wake, log, cfg } = setup();
    wake.start();
    cfg.sensitivity = 0.7;
    wake.reload();
    expect(log.filter((l) => l.startsWith("engine "))).toEqual([
      "engine pv 0.5",
      "engine release",
      "engine pv 0.7",
    ]);
  });
});

describe("SharedMic", () => {
  it("one holder at a time: the hand-over keeps the recorder running", async () => {
    const log: string[] = [];
    let n = 0;
    const shared = new SharedMic(async () => {
      log.push("open");
      return { read: async () => frame(++n), stop: () => void log.push("stop") };
    });
    const wake = await shared.acquire();
    expect((await wake.read())[0]).toBe(1);
    const session = await shared.acquire();
    await expect(wake.read()).rejects.toThrow(/handed over/);
    wake.stop(); // no longer the holder: doesn't stop the session's recorder
    expect((await session.read())[0]).toBe(2);
    session.stop();
    expect(log).toEqual(["open", "stop"]);
    await shared.acquire();
    expect(log).toEqual(["open", "stop", "open"]);
  });
});

describe("createPorcupine", () => {
  function fakeModule(fail?: Error) {
    const made: unknown[][] = [];
    const mod: PorcupineModule = {
      Porcupine: class {
        frameLength = 512;
        constructor(...args: unknown[]) {
          if (fail) throw fail;
          made.push(args);
        }
        process = () => -1;
        release = () => {};
      },
      BuiltinKeyword: { JARVIS: "jarvis" },
      getBuiltinKeywordPath: (k) =>
        `/Applications/JARVIS Desk.app/Contents/Resources/app.asar/node_modules/@picovoice/porcupine-node/resources/keyword_files/mac/${k}_mac.ppn`,
    };
    return { mod, made };
  }

  it("uses the built-in JARVIS keyword and model from outside the asar", () => {
    const { mod, made } = fakeModule();
    createPorcupine("key", 0.6, mod);
    const root =
      "/Applications/JARVIS Desk.app/Contents/Resources/app.asar.unpacked/node_modules/@picovoice/porcupine-node";
    expect(made[0]).toEqual([
      "key",
      [`${root}/resources/keyword_files/mac/jarvis_mac.ppn`],
      [0.6],
      { modelPath: `${root}/lib/common/porcupine_params.pv` },
    ]);
  });

  it("turns Picovoice's activation errors into WakeKeyError", () => {
    class PorcupineActivationError extends Error {}
    class PorcupineIOError extends Error {}
    expect(() => createPorcupine("bad", 0.5, fakeModule(new PorcupineActivationError("x")).mod)).toThrow(
      WakeKeyError,
    );
    expect(() => createPorcupine("k", 0.5, fakeModule(new PorcupineIOError("disk")).mod)).toThrow("disk");
    expect(isKeyError(new Error("AccessKey"))).toBe(false);
    expect(unpacked("/x/app.asar/y")).toBe("/x/app.asar.unpacked/y");
    expect(unpacked("/dev/node_modules/y")).toBe("/dev/node_modules/y");
  });
});

describe("falseTriggerEntry", () => {
  it("is one JSON line with when it triggered, when it was reported, and the sensitivity", () => {
    const line = falseTriggerEntry(Date.UTC(2026, 9, 15, 9), Date.UTC(2026, 9, 15, 9, 0, 4), 0.5);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      trigger: "2026-10-15T09:00:00.000Z",
      reported: "2026-10-15T09:00:04.000Z",
      sensitivity: 0.5,
    });
  });
});

describe("the pre-roll reaches the endpointer", () => {
  it("is handed to push-to-talk's listen (see session.test for the endpointer side)", async () => {
    const listen = vi.fn();
    const { wake, detectAt, feed } = setup({ onWake: (p) => listen(p) });
    detectAt.add(4);
    wake.start();
    feed(1, 2, 3, 4);
    await settle();
    expect(listen.mock.calls[0][0].map((f: Int16Array) => f[0])).toEqual([1, 2, 3, 4]);
  });
});

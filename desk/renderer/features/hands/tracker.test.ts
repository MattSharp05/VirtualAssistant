import { describe, expect, it, vi } from "vitest";
import { samplesFrom, startTracking, type Landmarker, type TrackerDeps, type TrackerState } from "./tracker";

/** 21 landmarks with the thumb tip (4) and index tip (8) set. */
const hand = (thumb: number, index: number) =>
  Array.from({ length: 21 }, (_, i) =>
    i === 4 ? { x: thumb, y: thumb } : i === 8 ? { x: index, y: index } : { x: 0, y: 0 },
  );

function fakes(opts: { camera?: Promise<MediaStream> } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const video = { currentTime: 0 } as HTMLVideoElement;
  const landmarker: Landmarker = {
    detectForVideo: vi.fn(() => ({ landmarks: [hand(0.4, 0.5)], handedness: [[{ categoryName: "Left" }]] })),
    close: vi.fn(),
  };
  let frame: (() => void) | undefined;
  let now = 0;
  const deps: TrackerDeps = {
    openCamera: vi.fn(() => opts.camera ?? Promise.resolve(stream)),
    createLandmarker: vi.fn(async () => landmarker),
    playVideo: vi.fn(async () => video),
    nextFrame: vi.fn((fn) => {
      frame = fn;
      return () => (frame = undefined);
    }),
    now: () => now,
  };
  /** A display frame `ms` later, with a new camera frame unless `sameVideo`. */
  const step = (ms: number, sameVideo = false) => {
    now += ms;
    if (!sameVideo) video.currentTime += ms / 1000;
    frame?.();
  };
  return { deps, track, stream, landmarker, step, hasFrame: () => frame !== undefined };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("samplesFrom", () => {
  it("takes the index and thumb tips of each hand, keeping same-labelled hands apart", () => {
    expect(
      samplesFrom({
        landmarks: [hand(0.1, 0.2), hand(0.3, 0.4), [{ x: 0, y: 0 }]],
        handedness: [[{ categoryName: "Left" }], [{ categoryName: "Left" }], []],
      }),
    ).toEqual([
      { hand: "Left", thumb: { x: 0.1, y: 0.1 }, index: { x: 0.2, y: 0.2 } },
      { hand: "Left-2", thumb: { x: 0.3, y: 0.3 }, index: { x: 0.4, y: 0.4 } },
    ]);
  });
});

describe("startTracking", () => {
  it("detects on new camera frames at up to 30 fps", async () => {
    const f = fakes();
    const frames: number[] = [];
    const states: TrackerState[] = [];
    startTracking({ onFrame: (_h, t) => frames.push(t), onState: (s) => states.push(s) }, f.deps);
    await flush();
    expect(states).toEqual(["starting", "tracking"]);
    expect(frames).toEqual([0]);
    f.step(16); // a camera frame, but too soon for 30 fps
    f.step(17, true); // that frame, now it's time
    f.step(17, true); // no new camera frame
    f.step(17);
    expect(frames).toEqual([0, 33, 67]);
    expect(f.landmarker.detectForVideo).toHaveBeenCalledTimes(3);
  });

  it("releases the camera and the model when stopped", async () => {
    const f = fakes();
    const states: TrackerState[] = [];
    const t = startTracking({ onFrame: () => {}, onState: (s) => states.push(s) }, f.deps);
    await flush();
    t.stop();
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.landmarker.close).toHaveBeenCalled();
    expect(f.hasFrame()).toBe(false);
    expect(states.at(-1)).toBe("stopped");
  });

  it("releases a camera that opens after it was already stopped", async () => {
    let open!: (s: MediaStream) => void;
    const f = fakes({ camera: new Promise((r) => (open = r)) });
    const t = startTracking({ onFrame: () => {} }, f.deps);
    t.stop();
    open(f.stream);
    await flush();
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.landmarker.close).toHaveBeenCalled();
    expect(f.deps.playVideo).not.toHaveBeenCalled();
  });

  it("reports an error (e.g. camera denied) and releases what it opened", async () => {
    const f = fakes({ camera: Promise.reject(new Error("NotAllowedError")) });
    const onState = vi.fn();
    startTracking({ onFrame: () => {}, onState }, f.deps);
    await flush();
    expect(onState).toHaveBeenLastCalledWith("error", expect.any(Error));
    expect(f.landmarker.close).toHaveBeenCalled();
  });
});

// The camera + MediaPipe HandLandmarker loop (JD-42, ADR 0012). Opens the front camera at 640×480,
// runs the landmarker on each new frame at up to 30 fps and reports each hand's index and thumb tips
// (normalised camera coordinates). stop() releases the camera (its light goes off) and the model.
// The browser parts are injectable so the loop's lifecycle is unit-tested without a camera.
import type { Point } from "./mapping";

/** MediaPipe's hand landmark indices. */
const THUMB_TIP = 4;
const INDEX_TIP = 8;

export const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

/** One hand in one frame, in camera space (0..1). */
export interface HandSample {
  /** MediaPipe's handedness label; stable while the hand stays in view, so it keys the smoothing. */
  hand: string;
  index: Point;
  thumb: Point;
}

/** The part of MediaPipe's HandLandmarker the loop uses. */
export interface Landmarker {
  detectForVideo(
    video: HTMLVideoElement,
    tMs: number,
  ): { landmarks: Point[][]; handedness: { categoryName: string }[][] };
  close(): void;
}

export interface TrackerDeps {
  openCamera(): Promise<MediaStream>;
  createLandmarker(): Promise<Landmarker>;
  /** A playing video of the stream. */
  playVideo(stream: MediaStream): Promise<HTMLVideoElement>;
  /** Calls fn on the next display frame; returns a cancel function. */
  nextFrame(fn: () => void): () => void;
  now(): number;
}

export type TrackerState = "starting" | "tracking" | "stopped" | "error";

export interface Tracking {
  stop(): void;
}

export interface TrackerCallbacks {
  onFrame(hands: HandSample[], tMs: number): void;
  onState?(state: TrackerState, error?: unknown): void;
}

/** Index + thumb tips of every hand MediaPipe found. */
export function samplesFrom(result: ReturnType<Landmarker["detectForVideo"]>): HandSample[] {
  const seen = new Set<string>();
  return result.landmarks.flatMap((points, i) => {
    const index = points[INDEX_TIP];
    const thumb = points[THUMB_TIP];
    if (!index || !thumb) return [];
    let hand = result.handedness[i]?.[0]?.categoryName ?? "Hand";
    // MediaPipe now and then labels both hands the same; keep them apart.
    if (seen.has(hand)) hand = `${hand}-2`;
    seen.add(hand);
    return [{ hand, index: { x: index.x, y: index.y }, thumb: { x: thumb.x, y: thumb.y } }];
  });
}

export function startTracking(cb: TrackerCallbacks, deps: TrackerDeps = browserDeps): Tracking {
  let stopped = false;
  let stream: MediaStream | undefined;
  let landmarker: Landmarker | undefined;
  let cancelFrame: (() => void) | undefined;

  const release = () => {
    cancelFrame?.();
    for (const track of stream?.getTracks() ?? []) track.stop();
    landmarker?.close();
    stream = landmarker = cancelFrame = undefined;
  };

  cb.onState?.("starting");
  (async () => {
    // Both at once: the camera's permission prompt and the model's load overlap.
    const [s, l] = await Promise.allSettled([deps.openCamera(), deps.createLandmarker()]);
    if (s.status === "fulfilled") stream = s.value;
    if (l.status === "fulfilled") landmarker = l.value;
    if (s.status === "rejected") throw s.reason;
    if (l.status === "rejected") throw l.reason;
    if (stopped) return release();
    const video = await deps.playVideo(stream!);
    if (stopped) return release();
    cb.onState?.("tracking");

    let lastVideoTime = -1;
    let lastDetect = -Infinity;
    const tick = () => {
      if (stopped) return;
      cancelFrame = deps.nextFrame(tick);
      const t = deps.now();
      // Only new camera frames, and no more than 30 a second (the CPU budget, ADR 0012).
      if (video.currentTime === lastVideoTime || t - lastDetect < FRAME_MS - 2) return;
      lastVideoTime = video.currentTime;
      lastDetect = t;
      cb.onFrame(samplesFrom(landmarker!.detectForVideo(video, t)), t);
    };
    tick();
  })().catch((err) => {
    release();
    if (stopped) return;
    stopped = true;
    cb.onState?.("error", err);
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      release();
      cb.onState?.("stopped");
    },
  };
}

// ── The real thing (Electron's overlay renderer, or a browser with a webcam) ──

/** The WASM runtime and the model, copied next to index.html at build time (vite.config.ts). */
const assetUrl = (file: string) => new URL(`mediapipe/${file}`, document.baseURI).href;

async function createLandmarker(): Promise<Landmarker> {
  // Loaded on first use, so the overlay doesn't pay for MediaPipe while Camera hands is off.
  const { HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = {
    wasmLoaderPath: assetUrl("vision_wasm_internal.js"),
    wasmBinaryPath: assetUrl("vision_wasm_internal.wasm"),
  };
  const create = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assetUrl("hand_landmarker.task"), delegate },
      runningMode: "VIDEO",
      numHands: 2,
    });
  try {
    return await create("GPU");
  } catch (err) {
    console.warn("Camera hands: no GPU delegate, using the CPU", err);
    return create("CPU");
  }
}

const browserDeps: TrackerDeps = {
  openCamera: () =>
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: 640, height: 480, frameRate: { ideal: TARGET_FPS } },
    }),
  createLandmarker,
  async playVideo(stream) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    return video;
  },
  nextFrame(fn) {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  },
  now: () => performance.now(),
};

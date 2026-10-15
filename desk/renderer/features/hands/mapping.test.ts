import { describe, expect, it } from "vitest";
import { ACTIVE_REGION, cameraToScreen, OneEuroFilter, PointSmoother } from "./mapping";

const SCREEN = { width: 1512, height: 944 };

/** Deterministic noise: mulberry32 + Box–Muller, so the fixture is the same on every run. */
function gaussian(seed: number) {
  let s = seed;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

const std = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

const FRAME_MS = 1000 / 30;
// MediaPipe fingertip jitter is ~0.3% of the frame; through the 70% region that's ~6 px on screen.
const NOISE_PX = 6;

describe("cameraToScreen", () => {
  const m = (1 - ACTIVE_REGION) / 2;

  it("maps the active region's corners to the screen's corners, mirrored", () => {
    // The camera's top-left (as the camera sees it) is Matthew's top-right.
    expect(cameraToScreen({ x: m, y: m }, SCREEN)).toEqual({ x: SCREEN.width, y: 0 });
    expect(cameraToScreen({ x: 1 - m, y: m }, SCREEN)).toEqual({ x: 0, y: 0 });
    const bl = cameraToScreen({ x: 1 - m, y: 1 - m }, SCREEN);
    expect(bl.x).toBeCloseTo(0, 6);
    expect(bl.y).toBeCloseTo(SCREEN.height, 6);
    const br = cameraToScreen({ x: m, y: 1 - m }, SCREEN);
    expect(br.x).toBeCloseTo(SCREEN.width, 6);
    expect(br.y).toBeCloseTo(SCREEN.height, 6);
    expect(cameraToScreen({ x: 0.5, y: 0.5 }, SCREEN)).toEqual({ x: SCREEN.width / 2, y: SCREEN.height / 2 });
  });

  it("clamps points outside the active region to the screen's edges", () => {
    expect(cameraToScreen({ x: 0, y: 0 }, SCREEN)).toEqual({ x: SCREEN.width, y: 0 });
    expect(cameraToScreen({ x: 1, y: 1.2 }, SCREEN)).toEqual({ x: 0, y: SCREEN.height });
  });

  it("takes another region size", () => {
    expect(cameraToScreen({ x: 0, y: 1 }, SCREEN, 1)).toEqual({ x: SCREEN.width, y: SCREEN.height });
    expect(cameraToScreen({ x: 0.25, y: 0.25 }, SCREEN, 0.5)).toEqual({ x: SCREEN.width, y: 0 });
  });
});

describe("one-euro smoothing", () => {
  it("starts at the first sample and ignores repeated timestamps", () => {
    const f = new OneEuroFilter();
    expect(f.filter(100, 0)).toBe(100);
    expect(f.filter(500, 0)).toBe(100);
    f.reset();
    expect(f.filter(42, 10)).toBe(42);
  });

  it("removes most of the jitter of a resting fingertip", () => {
    const noise = gaussian(7);
    const f = new OneEuroFilter();
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = 700 + NOISE_PX * noise();
      raw.push(v);
      out.push(f.filter(v, i * FRAME_MS));
    }
    // Skip the first second while the filter settles.
    const ratio = std(out.slice(30)) / std(raw.slice(30));
    expect(ratio).toBeLessThan(0.5);
  });

  for (const speed of [150, 600, 2000]) {
    it(`follows a sweep at ${speed} px/s with less than 80 ms lag`, () => {
      const noise = gaussian(speed);
      const f = new OneEuroFilter();
      const lags: number[] = [];
      for (let i = 0; i < 90; i++) {
        const t = i * FRAME_MS;
        const truth = (speed * t) / 1000;
        const out = f.filter(truth + NOISE_PX * noise(), t);
        // How far behind the true position, in time; after the first 10 frames (warm-up).
        if (i >= 10) lags.push(((truth - out) / speed) * 1000);
      }
      const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
      expect(mean).toBeLessThan(80);
    });
  }

  it("smooths both axes of a point", () => {
    const s = new PointSmoother();
    expect(s.filter({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
    const p = s.filter({ x: 20, y: 40 }, FRAME_MS);
    expect(p.x).toBeGreaterThan(10);
    expect(p.x).toBeLessThan(20);
    expect(p.y).toBeGreaterThan(20);
    expect(p.y).toBeLessThan(40);
    s.reset();
    expect(s.filter({ x: 5, y: 5 }, 2 * FRAME_MS)).toEqual({ x: 5, y: 5 });
  });
});

// Camera space → screen space for the hand pointers (JD-42, ADR 0012): pure functions, unit-tested.
// MediaPipe gives landmarks normalised to the camera frame (0..1, x to the right of the *camera*). The
// front camera sees Matthew mirrored, so x is flipped; only the centre of the frame (the active
// region) maps to the screen, so a fingertip reaches the screen's edges without leaving the frame.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The share of the camera frame (each axis, centred) that maps to the whole screen. */
export const ACTIVE_REGION = 0.7;

/** A normalised camera point (0..1) → screen pixels, mirrored, clamped to the screen. */
export function cameraToScreen(p: Point, screen: Size, region = ACTIVE_REGION): Point {
  const margin = (1 - region) / 2;
  const fit = (v: number) => Math.min(1, Math.max(0, (v - margin) / region));
  return { x: fit(1 - p.x) * screen.width, y: fit(p.y) * screen.height };
}

export interface OneEuroOptions {
  /** Hz: how much a still hand is smoothed (lower = steadier, laggier). */
  minCutoff: number;
  /** How fast the cutoff rises with speed (higher = less lag when moving). Per px/s here. */
  beta: number;
  /** Hz: the cutoff for the speed estimate itself. */
  dCutoff: number;
}

/** Tuned on screen pixels at ~30 fps: a resting hand stays put, a fast sweep lags < 80 ms. */
export const SMOOTHING: OneEuroOptions = { minCutoff: 1.2, beta: 0.02, dCutoff: 1 };

const alpha = (cutoff: number, dtS: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dtS));

/**
 * The one-euro filter (Casiez et al., CHI 2012): a low-pass filter whose cutoff rises with speed, so
 * jitter is removed when the hand is slow and lag stays small when it moves fast.
 */
export class OneEuroFilter {
  private x?: number;
  private dx = 0;
  private t?: number;

  constructor(private readonly opts: OneEuroOptions = SMOOTHING) {}

  /** The smoothed value of `value` seen at `tMs`. */
  filter(value: number, tMs: number): number {
    if (this.x === undefined || this.t === undefined) {
      // First sample: nothing to smooth against.
      this.x = value;
      this.t = tMs;
      return value;
    }
    if (tMs <= this.t) return this.x;
    const dt = (tMs - this.t) / 1000;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.opts.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    this.t = tMs;
    return this.x;
  }

  reset(): void {
    this.x = this.t = undefined;
    this.dx = 0;
  }
}

/** A one-euro filter per axis for one screen point. */
export class PointSmoother {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(opts: OneEuroOptions = SMOOTHING) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
  }

  filter(p: Point, tMs: number): Point {
    return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}

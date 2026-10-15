// Hand samples → gestures (JD-47, ADR 0012): pure, one frame at a time, unit-tested on recorded
// fixtures. A pinch is the thumb and index tips closer than 0.35 × the palm's width (so it works at any
// distance from the camera) and lasts until they're 0.45 × apart (hysteresis: no flicker at the edge).
// While pinched the pinch point drags; a release faster than 1.8 screen-widths a second is a flick.
// Two hands pinched at once scale by the ratio of the distance between their pinch points.
import { cameraDistance, cameraToScreen, PointSmoother, type Point, type Size } from "./mapping";
import type { HandSample } from "./tracker";

/** Pinch starts below this share of the palm's width... */
export const PINCH_ON = 0.35;
/** ...and ends above this one. */
export const PINCH_OFF = 0.45;
/** Release speed (screen widths a second) above which a release is a flick. */
export const FLICK_SPEED = 1.8;
/** The release speed is measured over this last stretch of the drag. */
export const FLICK_WINDOW_MS = 100;
/** A pinching hand missing for longer than this (MediaPipe drops a frame now and then) is released. */
export const LOST_MS = 150;

export type GestureEvent =
  | { type: "pinchstart"; hand: string; point: Point }
  | { type: "pinchmove"; hand: string; point: Point }
  /** velocity in px/s; never a flick when the hand was part of a two-hand scale or was lost. */
  | { type: "pinchend"; hand: string; point: Point; velocity: Point; flick: boolean }
  | { type: "scalestart"; hands: [string, string]; points: [Point, Point]; centre: Point }
  /** ratio = the distance between the pinch points now / at scalestart. */
  | { type: "scale"; ratio: number; centre: Point }
  | { type: "scaleend" };

interface HandState {
  smoother: PointSmoother;
  point: Point;
  pinching: boolean;
  /** Took part in a two-hand scale during this pinch. */
  scaled: boolean;
  lastSeen: number;
  /** Recent pinch points while pinching, for the release speed. */
  trail: { t: number; p: Point }[];
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Pinch state for the next frame: on below PINCH_ON, off above PINCH_OFF, unchanged in between. */
export function nextPinch(wasPinching: boolean, sample: HandSample): boolean {
  if (!sample.palm) return wasPinching; // no palm width this frame: keep what it was
  const ratio = cameraDistance(sample.thumb, sample.index) / sample.palm;
  return wasPinching ? ratio <= PINCH_OFF : ratio < PINCH_ON;
}

/** px/s over the trail's last FLICK_WINDOW_MS (zero with fewer than two points). */
export function releaseVelocity(trail: { t: number; p: Point }[]): Point {
  const last = trail.at(-1);
  if (!last) return { x: 0, y: 0 };
  const first = trail.find((s) => last.t - s.t <= FLICK_WINDOW_MS) ?? last;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { x: 0, y: 0 };
  return { x: (last.p.x - first.p.x) / dt, y: (last.p.y - first.p.y) / dt };
}

export class GestureRecognizer {
  private readonly hands = new Map<string, HandState>();
  private scale?: { hands: [string, string]; from: number };

  /** Whether this hand is pinching now (the pointer ring fills). */
  pinching(hand: string): boolean {
    return this.hands.get(hand)?.pinching ?? false;
  }

  /** Feeds one frame (camera-space samples); returns what happened, in order. */
  update(samples: HandSample[], tMs: number, screen: Size): GestureEvent[] {
    const events: GestureEvent[] = [];
    const seen = new Set<string>();
    for (const s of samples) {
      seen.add(s.hand);
      let h = this.hands.get(s.hand);
      if (!h) {
        h = {
          smoother: new PointSmoother(),
          point: { x: 0, y: 0 },
          pinching: false,
          scaled: false,
          lastSeen: tMs,
          trail: [],
        };
        this.hands.set(s.hand, h);
      }
      // Back after a gap: start smoothing afresh rather than gliding from where it was.
      if (tMs - h.lastSeen > LOST_MS) h.smoother.reset();
      h.lastSeen = tMs;
      h.point = h.smoother.filter(cameraToScreen(mid(s.thumb, s.index), screen), tMs);
      const pinching = nextPinch(h.pinching, s);
      if (pinching && !h.pinching) {
        h.pinching = true;
        h.scaled = false;
        h.trail = [{ t: tMs, p: h.point }];
        events.push({ type: "pinchstart", hand: s.hand, point: h.point });
      } else if (pinching) {
        h.trail.push({ t: tMs, p: h.point });
        h.trail = h.trail.filter((x) => tMs - x.t <= FLICK_WINDOW_MS);
        events.push({ type: "pinchmove", hand: s.hand, point: h.point });
      } else if (h.pinching) {
        h.trail.push({ t: tMs, p: h.point });
        this.release(s.hand, h, events, true, screen);
      }
    }
    // Hands that went missing: released (never a flick) once they've been gone for LOST_MS.
    for (const [id, h] of this.hands) {
      if (seen.has(id) || tMs - h.lastSeen <= LOST_MS) continue;
      if (h.pinching) this.release(id, h, events, false, screen);
      this.hands.delete(id);
    }
    this.updateScale(events);
    return events;
  }

  /** Forgets everything (Camera hands turned off), ending what was in progress. */
  clear(): GestureEvent[] {
    const events: GestureEvent[] = [];
    for (const [id, h] of this.hands)
      if (h.pinching) this.release(id, h, events, false, { width: 1, height: 1 });
    this.hands.clear();
    return events;
  }

  private release(id: string, h: HandState, events: GestureEvent[], canFlick: boolean, screen: Size) {
    if (this.scale?.hands.includes(id)) {
      events.push({ type: "scaleend" });
      this.scale = undefined;
    }
    const velocity = releaseVelocity(h.trail);
    const speed = Math.hypot(velocity.x, velocity.y) / screen.width;
    h.pinching = false;
    h.trail = [];
    events.push({
      type: "pinchend",
      hand: id,
      point: h.point,
      velocity,
      flick: canFlick && !h.scaled && speed > FLICK_SPEED,
    });
  }

  private updateScale(events: GestureEvent[]) {
    const pinched = [...this.hands].filter(([, h]) => h.pinching);
    if (this.scale) {
      const [a, b] = this.scale.hands.map((id) => this.hands.get(id)!.point);
      events.push({ type: "scale", ratio: dist(a, b) / this.scale.from, centre: mid(a, b) });
      return;
    }
    if (pinched.length !== 2) return;
    const [[ida, a], [idb, b]] = pinched;
    a.scaled = b.scaled = true;
    this.scale = { hands: [ida, idb], from: Math.max(1, dist(a.point, b.point)) };
    events.push({
      type: "scalestart",
      hands: [ida, idb],
      points: [a.point, b.point],
      centre: mid(a.point, b.point),
    });
  }
}

/**
 * A window's bounds scaled by `ratio` around its centre, never smaller than `min` (the feature's
 * minSize) and rounded to whole pixels.
 */
export function scaleRect(
  rect: { x: number; y: number; width: number; height: number },
  ratio: number,
  min: Size,
): { x: number; y: number; width: number; height: number } {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const width = Math.round(Math.max(min.width, rect.width * r));
  const height = Math.round(Math.max(min.height, rect.height * r));
  return {
    x: Math.round(rect.x + (rect.width - width) / 2),
    y: Math.round(rect.y + (rect.height - height) / 2),
    width,
    height,
  };
}

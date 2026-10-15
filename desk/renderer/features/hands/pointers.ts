// Hand samples → what the pointer layer draws (JD-42): each hand's index fingertip (a ring) and thumb
// tip (a dot) in screen pixels, smoothed, and whether it's still shown. A hand that goes unseen for
// FADE_AFTER_MS fades out; when it comes back its smoothing starts afresh (no swoop from where it was).
import { cameraToScreen, PointSmoother, type Point, type Size } from "./mapping";
import type { HandSample } from "./tracker";

export const FADE_AFTER_MS = 500;

export interface HandPointer {
  hand: string;
  index: Point;
  thumb: Point;
  visible: boolean;
}

interface Track {
  index: PointSmoother;
  thumb: PointSmoother;
  pointer: HandPointer;
  lastSeen: number;
}

export class HandPointers {
  private readonly tracks = new Map<string, Track>();

  /** Feeds one frame; returns every hand seen so far, current or fading. */
  update(hands: HandSample[], tMs: number, screen: Size): HandPointer[] {
    for (const h of hands) {
      let track = this.tracks.get(h.hand);
      if (!track) {
        track = {
          index: new PointSmoother(),
          thumb: new PointSmoother(),
          pointer: { hand: h.hand, index: { x: 0, y: 0 }, thumb: { x: 0, y: 0 }, visible: false },
          lastSeen: -Infinity,
        };
        this.tracks.set(h.hand, track);
      }
      if (!track.pointer.visible) {
        track.index.reset();
        track.thumb.reset();
      }
      track.lastSeen = tMs;
      track.pointer = {
        hand: h.hand,
        index: track.index.filter(cameraToScreen(h.index, screen), tMs),
        thumb: track.thumb.filter(cameraToScreen(h.thumb, screen), tMs),
        visible: true,
      };
    }
    return this.tick(tMs);
  }

  /** Fades hands not seen for FADE_AFTER_MS (also called when no frame arrives). */
  tick(tMs: number): HandPointer[] {
    for (const track of this.tracks.values())
      if (track.pointer.visible && tMs - track.lastSeen >= FADE_AFTER_MS)
        track.pointer = { ...track.pointer, visible: false };
    return [...this.tracks.values()].map((t) => t.pointer);
  }

  clear(): void {
    this.tracks.clear();
  }
}

// File drop on the orb (JD-40). macOS doesn't hand a drag to a window that ignores the mouse, and the
// click-through overlay gets no mouse moves while a drag is under way, so main watches the pointer
// instead: while it's on the orb's spot the overlay takes the mouse, a dragged file reaches it, and the
// renderer shows the drop ring (holding the overlay interactive until the drag ends). Pure, for tests.
import type { Rect } from "./bounds";

/** How often the pointer is checked (cheap: one cursor read). */
export const DROP_POLL_MS = 120;

/** The corner orb (overlay.css: 28 px dot, 28 px in from the top and right) plus this much around it. */
const ORB_INSET = 28;
const ORB_SIZE = 28;
const MARGIN = 26;

/** The square around the corner orb, in screen coordinates, for the overlay's work area. */
export function orbZone(workArea: Rect): Rect {
  const size = ORB_SIZE + 2 * MARGIN;
  return {
    x: workArea.x + workArea.width - ORB_INSET - ORB_SIZE - MARGIN,
    y: workArea.y + ORB_INSET - MARGIN,
    width: size,
    height: size,
  };
}

export function inside(point: { x: number; y: number }, r: Rect): boolean {
  return point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height;
}

/**
 * Whether the overlay takes the mouse: the renderer's hit regions (orb, ring, cards, a drag in
 * progress) or the pointer on the orb's spot. Reports only changes.
 */
export class OverlayMouse {
  private hit = false;
  private near = false;
  private last: boolean | undefined;

  constructor(private readonly apply: (interactive: boolean) => void) {}

  setHit(on: boolean): void {
    this.hit = on;
    this.flush();
  }

  setNear(on: boolean): void {
    this.near = on;
    this.flush();
  }

  private flush(): void {
    const next = this.hit || this.near;
    if (next === this.last) return;
    this.last = next;
    this.apply(next);
  }
}

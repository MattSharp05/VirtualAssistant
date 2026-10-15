// Camera-hand gestures on Desk windows (JD-47): pure helpers for main's side. The overlay asks which
// window is under a pinch in its own coordinates; main answers from its windows, front to back, and
// turns the overlay's bounds back into screen coordinates (clamped to the feature's min size).
import type { HandWindow } from "@jarvis/shared";
import type { Rect } from "./bounds";

/** The frame's title bar (app/window-frame.css): a pinch there grabs the window. */
export const TITLE_BAR_HEIGHT = 48;

export interface StackedWindow {
  id: string;
  /** Screen coordinates. */
  bounds: Rect;
  minSize: { width: number; height: number };
}

export interface Offset {
  x: number;
  y: number;
}

const inside = (p: Offset, r: Rect) =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/**
 * The frontmost window whose title bar (or, for "any", whose whole rect) is under `point`; point and
 * answer are in the coordinates of a window whose top-left is at `origin` on screen.
 */
export function windowAt(
  stack: StackedWindow[],
  point: Offset,
  part: "titlebar" | "any",
  origin: Offset,
): HandWindow | undefined {
  const p = { x: point.x + origin.x, y: point.y + origin.y };
  for (const w of stack) {
    const zone =
      part === "titlebar" ? { ...w.bounds, height: Math.min(TITLE_BAR_HEIGHT, w.bounds.height) } : w.bounds;
    if (inside(p, zone))
      return {
        id: w.id,
        bounds: { ...w.bounds, x: w.bounds.x - origin.x, y: w.bounds.y - origin.y },
        minSize: w.minSize,
      };
  }
  return undefined;
}

/** The overlay's bounds for a window → screen bounds, whole pixels, never below the min size. */
export function screenBounds(rect: Rect, origin: Offset, min: { width: number; height: number }): Rect {
  return {
    x: Math.round(rect.x + origin.x),
    y: Math.round(rect.y + origin.y),
    width: Math.round(Math.max(min.width, rect.width)),
    height: Math.round(Math.max(min.height, rect.height)),
  };
}

/** True for a usable rect sent over IPC (finite numbers, positive size). */
export function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k])) &&
    (r.width as number) > 0 &&
    (r.height as number) > 0
  );
}

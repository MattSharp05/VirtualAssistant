// Where a window reopens: its saved bounds if they're still on a connected display, otherwise back on
// the primary display (a window last seen on an unplugged monitor must not open off screen).
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much of the title bar must be visible on some display for saved bounds to count. */
const VISIBLE_W = 120;
const VISIBLE_H = 48;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/** A rect of `size` centred in `area`, shrunk to fit. */
export function centred(size: { width: number; height: number }, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Saved bounds stay as they are when their title bar is on one of the displays' work areas; else the
 * window keeps its size (shrunk to fit) and is centred on the primary display.
 */
export function restoreBounds(saved: Rect, workAreas: Rect[], primary: Rect): Rect {
  const titleBar = { ...saved, height: VISIBLE_H };
  const visible = workAreas.some((area) => {
    const o = overlap(titleBar, area);
    return o.width >= Math.min(VISIBLE_W, saved.width) && o.height >= VISIBLE_H;
  });
  return visible ? saved : centred(saved, primary);
}

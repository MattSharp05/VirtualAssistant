// Where the command bar opens (JD-28): centred across the display Matthew is working on (the one with
// the pointer), a fifth of the way down, like Spotlight. Pure, so it's unit-tested without Electron.
import type { Rect } from "./bounds";

export function commandBarBounds(size: { width: number; height: number }, workArea: Rect): Rect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const top = Math.round(workArea.height * 0.2);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + Math.min(top, workArea.height - height),
    width,
    height,
  };
}

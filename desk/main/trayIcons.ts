// The tray's pictures, drawn as raw pixels (BGRA, Electron's nativeImage.createFromBitmap): the
// menu-bar glyph (a small orb: a ring around a dot, black on transparent so macOS can tint it as a
// template image) and the coloured dots for the connection line. Drawn here rather than shipped as
// PNGs so they're crisp at 1× and 2× and need no packaging.
import type { DeskConnection } from "@jarvis/shared";

export interface Bitmap {
  width: number;
  height: number;
  /** BGRA (premultiplied), row by row. */
  data: Buffer;
}

type Rgb = [number, number, number];

/** Draws with 4×4 supersampling: `coverage(x, y)` says whether a point (in pixels) is inked. */
function draw(size: number, rgb: Rgb, coverage: (x: number, y: number) => boolean): Bitmap {
  const data = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) if (coverage(x + (sx + 0.5) / n, y + (sy + 0.5) / n)) hits++;
      const i = (y * size + x) * 4;
      const a = hits / (n * n);
      // Skia's native format: BGRA with premultiplied alpha.
      data[i] = Math.round(rgb[2] * a);
      data[i + 1] = Math.round(rgb[1] * a);
      data[i + 2] = Math.round(rgb[0] * a);
      data[i + 3] = Math.round(a * 255);
    }
  return { width: size, height: size, data };
}

/** The menu-bar orb, `points` wide at `scale` (18 pt, like other menu-bar icons). */
export function orbGlyph(scale: 1 | 2, points = 18): Bitmap {
  const size = points * scale;
  const c = size / 2;
  const ringOuter = 7.5 * scale;
  const ringInner = 6 * scale;
  const dot = 3.5 * scale;
  return draw(size, [0, 0, 0], (x, y) => {
    const r = Math.hypot(x - c, y - c);
    return r <= dot || (r >= ringInner && r <= ringOuter);
  });
}

/** The theme's status colours (renderer/app/theme.css). */
const COLOURS: Record<DeskConnection["state"], Rgb> = {
  connected: [0x5f, 0xd4, 0x9a],
  connecting: [0xf2, 0xb2, 0x4c],
  offline: [0xf2, 0x68, 0x5c],
  unauthorized: [0xf2, 0x68, 0x5c],
  unconfigured: [0x9a, 0xa7, 0xb2],
};

/** A filled dot for the connection line: 12 pt square, 8 pt across. */
export function statusDot(state: DeskConnection["state"], scale: 1 | 2): Bitmap {
  const size = 12 * scale;
  const c = size / 2;
  return draw(size, COLOURS[state], (x, y) => Math.hypot(x - c, y - c) <= 4 * scale);
}

// The tray's pictures, drawn as raw pixels (BGRA, Electron's nativeImage.createFromBitmap): the
// menu-bar glyph (a small orb: a ring around a dot, black on transparent so macOS can tint it as a
// template image) and the coloured dots for the connection line. Drawn here rather than shipped as
// PNGs so they're crisp at 1× and 2× and need no packaging. tray.ts hands them to Electron as PNG
// (encodePng), the well-trodden path for menu-bar images (JD-62: the raw-bitmap image didn't show).
import { deflateSync } from "node:zlib";
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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A bitmap as a PNG (8-bit RGBA, straight alpha), for nativeImage.createFromBuffer. */
export function encodePng(bmp: Bitmap): Buffer {
  const { width, height, data } = bmp;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1); // each row starts with filter type 0 (none)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = row + 1 + x * 4;
      const a = data[i + 3]!;
      // BGRA premultiplied → RGBA straight.
      const un = (v: number) => (a ? Math.min(255, Math.round((v * 255) / a)) : 0);
      rows[o] = un(data[i + 2]!);
      rows[o + 1] = un(data[i + 1]!);
      rows[o + 2] = un(data[i]!);
      rows[o + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, adaptive filtering, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

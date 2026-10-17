// @vitest-environment node
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, orbGlyph, statusDot } from "./trayIcons";

/** Just enough of a PNG reader for encodePng's output: size, colour type and the RGBA rows. */
function decode(png: Buffer) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: Record<string, Buffer> = {};
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    chunks[png.toString("ascii", at + 4, at + 8)] = png.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  const ihdr = chunks.IHDR!;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const rows = inflateSync(chunks.IDAT!);
  const pixel = (x: number, y: number) => {
    const o = y * (width * 4 + 1) + 1 + x * 4;
    return [...rows.subarray(o, o + 4)];
  };
  return { width, height, depth: ihdr[8], colour: ihdr[9], rows, pixel, chunks: Object.keys(chunks) };
}

describe("tray icons as PNG (JD-62)", () => {
  it("the menu-bar glyph is an 18 pt RGBA PNG at 1× and 2×, with ink in it", () => {
    for (const scale of [1, 2] as const) {
      const png = decode(encodePng(orbGlyph(scale)));
      expect(png.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
      expect([png.width, png.height, png.depth, png.colour]).toEqual([18 * scale, 18 * scale, 8, 6]);
      expect(png.rows.length).toBe(18 * scale * (18 * scale * 4 + 1));
      // The centre dot is solid black; the corners are clear (a template image is alpha only).
      const c = 9 * scale;
      expect(png.pixel(c, c)).toEqual([0, 0, 0, 255]);
      expect(png.pixel(0, 0)).toEqual([0, 0, 0, 0]);
    }
  });

  it("undoes premultiplied alpha, so a coloured dot keeps its colour", () => {
    const png = decode(encodePng(statusDot("connected", 2)));
    expect(png.pixel(12, 12)).toEqual([0x5f, 0xd4, 0x9a, 255]);
    // An edge pixel is partly covered but still the same green, not darkened.
    let edge: number[] | undefined;
    for (let y = 0; y < 24 && !edge; y++)
      for (let x = 0; x < 24 && !edge; x++) {
        const p = png.pixel(x, y);
        if (p[3]! > 0 && p[3]! < 128) edge = p;
      }
    expect(edge).toBeDefined();
    expect(Math.abs(edge![1]! - 0xd4)).toBeLessThanOrEqual(3);
  });
});

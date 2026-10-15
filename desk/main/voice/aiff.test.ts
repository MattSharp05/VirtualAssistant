// @vitest-environment node
import { describe, expect, it } from "vitest";
import { envelope, parseAiff } from "./aiff";

/** 22050 Hz as an 80-bit extended float (what `say` writes). */
function extended(rate: number): Buffer {
  const b = Buffer.alloc(10);
  const exp = Math.floor(Math.log2(rate));
  b.writeUInt16BE(16383 + exp, 0);
  const mantissa = rate / 2 ** exp; // 1.xxx
  b.writeUInt32BE(Math.floor(mantissa * 2 ** 31), 2);
  return b;
}

function chunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** A mono 16-bit AIFF (or AIFF-C with `encoding`) holding `samples` (-1…1). */
function aiff(samples: number[], rate = 22050, encoding?: "NONE" | "sowt"): Buffer {
  const comm = Buffer.concat([
    Buffer.alloc(8),
    extended(rate),
    encoding ? Buffer.from(`${encoding}\0\0`) : Buffer.alloc(0),
  ]);
  comm.writeUInt16BE(1, 0);
  comm.writeUInt32BE(samples.length, 2);
  comm.writeUInt16BE(16, 6);
  const data = Buffer.alloc(8 + samples.length * 2);
  samples.forEach((s, i) => {
    const v = Math.round(s * 32767);
    if (encoding === "sowt") data.writeInt16LE(v, 8 + i * 2);
    else data.writeInt16BE(v, 8 + i * 2);
  });
  const chunks = [chunk("COMM", comm), chunk("SSND", data)];
  if (encoding) chunks.unshift(chunk("FVER", Buffer.alloc(4)));
  const body = Buffer.concat([Buffer.from(encoding ? "AIFC" : "AIFF"), ...chunks]);
  return Buffer.concat([chunk("FORM", body).subarray(0, 8), body]);
}

describe("parseAiff", () => {
  it("reads a plain AIFF's rate and samples", () => {
    const pcm = parseAiff(aiff([0, 0.5, -0.5, 1]))!;
    expect(pcm.sampleRate).toBe(22050);
    expect([...pcm.samples].map((s) => Math.round(s * 100) / 100)).toEqual([0, 0.5, -0.5, 1]);
  });

  it("reads little-endian AIFF-C", () => {
    const pcm = parseAiff(aiff([0.25, -0.25], 16000, "sowt"))!;
    expect(pcm.sampleRate).toBe(16000);
    expect([...pcm.samples].map((s) => Math.round(s * 100) / 100)).toEqual([0.25, -0.25]);
  });

  it("rejects what isn't AIFF", () => {
    expect(parseAiff(Buffer.from("RIFF....WAVEfmt "))).toBeUndefined();
    expect(parseAiff(Buffer.alloc(4))).toBeUndefined();
  });
});

describe("envelope", () => {
  it("gives one loudness per 1/30 s, loudest = 1, silence = 0", () => {
    const rate = 3000; // 100 samples a frame
    const samples = [
      ...Array<number>(100).fill(0),
      ...Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.8 : -0.8)),
      ...Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.4 : -0.4)),
    ];
    expect(envelope({ sampleRate: rate, samples: Float32Array.from(samples) })).toEqual([0, 1, 0.5]);
  });

  it("doesn't blow near-silence up to full loudness", () => {
    const samples = Float32Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(envelope({ sampleRate: 3000, samples })).toEqual([0.2, 0.2]);
  });
});

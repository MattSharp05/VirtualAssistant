// The orb pulses with JARVIS's voice (JD-38): `say -o` writes each sentence as an AIFF file, and
// envelope() turns its samples into one loudness value (0–1) per 1/30 s, which the speaker sends as
// orb.state speaking { amplitude } while the sentence plays. parseAiff reads plain AIFF and the
// AIFF-C encodings `say` can write (big- or little-endian integers, 32/64-bit floats). Pure.

export interface Pcm {
  sampleRate: number;
  /** Mono (channels averaged), -1…1. */
  samples: Float32Array;
}

/** The 80-bit IEEE extended float AIFF stores its sample rate in. */
function readExtended(buf: Buffer, at: number): number {
  const sign = buf[at]! & 0x80 ? -1 : 1;
  const exponent = ((buf[at]! & 0x7f) << 8) | buf[at + 1]!;
  const mantissa = buf.readUInt32BE(at + 2) * 2 ** 32 + buf.readUInt32BE(at + 6);
  if (exponent === 0 && mantissa === 0) return 0;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

/** An AIFF/AIFF-C file's audio as mono floats; undefined when it isn't one this can read. */
export function parseAiff(buf: Buffer): Pcm | undefined {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "FORM") return undefined;
  const form = buf.toString("ascii", 8, 12);
  if (form !== "AIFF" && form !== "AIFC") return undefined;
  let channels = 0;
  let frames = 0;
  let bits = 0;
  let sampleRate = 0;
  let encoding = "NONE";
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32BE(at + 4);
    const body = at + 8;
    if (id === "COMM" && body + 18 <= buf.length) {
      channels = buf.readUInt16BE(body);
      frames = buf.readUInt32BE(body + 2);
      bits = buf.readUInt16BE(body + 6);
      sampleRate = readExtended(buf, body + 8);
      if (form === "AIFC" && body + 22 <= buf.length) encoding = buf.toString("ascii", body + 18, body + 22);
    } else if (id === "SSND" && body + 8 <= buf.length) {
      const offset = buf.readUInt32BE(body);
      data = buf.subarray(body + 8 + offset, Math.min(buf.length, body + size));
    }
    at = body + size + (size % 2); // chunks are padded to an even length
  }
  if (!data || !channels || !sampleRate) return undefined;
  const read = sampleReader(encoding, bits);
  if (!read) return undefined;
  const width = read.bytes * channels;
  const count = Math.min(frames, Math.floor(data.length / width));
  const samples = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read.at(data, f * width + c * read.bytes);
    samples[f] = sum / channels;
  }
  return { sampleRate, samples };
}

function sampleReader(
  encoding: string,
  bits: number,
): { bytes: number; at: (b: Buffer, i: number) => number } | undefined {
  const enc = encoding.toLowerCase();
  if (enc === "fl32") return { bytes: 4, at: (b, i) => b.readFloatBE(i) };
  if (enc === "fl64") return { bytes: 8, at: (b, i) => b.readDoubleBE(i) };
  const little = enc === "sowt";
  if (enc !== "none" && enc !== "twos" && !little) return undefined;
  const bytes = Math.ceil(bits / 8);
  if (bytes < 1 || bytes > 4) return undefined;
  const scale = 2 ** (bytes * 8 - 1);
  return {
    bytes,
    at: (b, i) => (little ? b.readIntLE(i, bytes) : b.readIntBE(i, bytes)) / scale,
  };
}

/** Frames per second of the orb's amplitude (and of the speaker's orb.state events). */
export const ENVELOPE_HZ = 30;

/**
 * Loudness per 1/30 s (RMS), scaled so the sentence's loudest moment is 1; near-silence stays near 0
 * (the scale never goes above what a quiet voice would get).
 */
export function envelope(pcm: Pcm, hz = ENVELOPE_HZ): number[] {
  const size = Math.max(1, Math.round(pcm.sampleRate / hz));
  const rms: number[] = [];
  for (let at = 0; at < pcm.samples.length; at += size) {
    const end = Math.min(pcm.samples.length, at + size);
    let sum = 0;
    for (let i = at; i < end; i++) sum += pcm.samples[i]! * pcm.samples[i]!;
    rms.push(Math.sqrt(sum / (end - at)));
  }
  const peak = Math.max(0.05, ...rms);
  return rms.map((r) => Math.round(Math.min(1, r / peak) * 100) / 100);
}

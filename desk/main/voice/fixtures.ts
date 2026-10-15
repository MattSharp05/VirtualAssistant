// Test recordings for the voice tests: 16 kHz frames of speech, background noise and silence, each
// with the speech probability Silero gives that kind of audio (speech ~0.9, a fan or keyboard noise
// hovering at 0.1–0.45, silence ~0.02). Deterministic (seeded), so a failure replays exactly.
import { FRAME_LENGTH, SAMPLE_RATE } from "../audio/recorder";

export type Segment = ["speech" | "noise" | "silence" | "pause", number];

export interface Recording {
  frames: Int16Array[];
  probabilities: number[];
}

/** Frames needed for `ms` of audio (rounded up). */
export const framesFor = (ms: number) => Math.ceil((ms * SAMPLE_RATE) / 1000 / FRAME_LENGTH);

export function record(segments: Segment[], seed = 1): Recording {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const frames: Int16Array[] = [];
  const probabilities: number[] = [];
  let t = 0;
  for (const [kind, ms] of segments) {
    for (let i = 0; i < framesFor(ms); i++) {
      const frame = new Int16Array(FRAME_LENGTH);
      for (let j = 0; j < FRAME_LENGTH; j++, t++) {
        const n = rand() * 2 - 1;
        frame[j] =
          kind === "speech"
            ? // a voiced 140 Hz buzz with a 4 Hz syllable envelope, plus breath
              Math.round(
                (Math.sin((2 * Math.PI * 140 * t) / SAMPLE_RATE) * 9000 + n * 1500) *
                  (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * t) / SAMPLE_RATE)),
              )
            : kind === "noise"
              ? Math.round(n * 2500)
              : Math.round(n * 60);
      }
      frames.push(frame);
      probabilities.push(
        kind === "speech"
          ? 0.85 + rand() * 0.14
          : kind === "noise"
            ? 0.1 + rand() * 0.35
            : kind === "pause"
              ? 0.2
              : 0.01 + rand() * 0.03,
      );
    }
  }
  return { frames, probabilities };
}

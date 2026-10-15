// @vitest-environment node
import { expect, it } from "vitest";
import { createSileroVad, type OrtLike } from "./vad";

it("feeds Silero 64 samples of context + the frame, and carries its state", async () => {
  const runs: { input: Float32Array; dims: number[]; state: Float32Array; sr: bigint }[] = [];
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: Float32Array | BigInt64Array,
      readonly dims: number[],
    ) {}
  }
  const ort: OrtLike = {
    Tensor,
    InferenceSession: {
      create: async (path) => {
        expect(path).toBe("/models/silero-vad.onnx");
        return {
          run: async (feeds) => {
            const f = feeds as Record<string, Tensor>;
            runs.push({
              input: f.input.data as Float32Array,
              dims: f.input.dims,
              state: f.state.data as Float32Array,
              sr: (f.sr.data as BigInt64Array)[0],
            });
            return {
              output: { data: Float32Array.of(0.9) },
              stateN: { data: new Float32Array(256).fill(runs.length) },
            };
          },
        };
      },
    },
  };
  const vad = await createSileroVad("/models/silero-vad.onnx", ort);
  const frame = new Int16Array(512).map((_, i) => i);
  expect(await vad.probability(frame)).toBeCloseTo(0.9);
  await vad.probability(frame);
  expect(runs[0].dims).toEqual([1, 576]);
  expect(runs[0].sr).toBe(16000n);
  expect(runs[0].input.slice(0, 64).every((v) => v === 0)).toBe(true);
  expect(runs[0].input[64 + 10]).toBeCloseTo(10 / 32768);
  // The second frame sees the first's last 64 samples, and the state the model returned.
  expect(runs[1].input[0]).toBeCloseTo(448 / 32768);
  expect(runs[1].state[0]).toBe(1);
  vad.reset();
  await vad.probability(frame);
  expect(runs[2].state[0]).toBe(0);
  expect(runs[2].input[0]).toBe(0);
});

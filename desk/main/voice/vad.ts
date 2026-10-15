// Silero VAD (v5) on onnxruntime-node: the speech probability of each 512-sample 16 kHz frame. The
// model is stateful (an LSTM state carried from frame to frame) and, like the reference
// implementation, sees the previous frame's last 64 samples in front of each new one. onnxruntime is
// loaded lazily (a native module, external to the bundle) and injectable for tests.

/** The parts of onnxruntime-node used here. */
export interface OrtLike {
  Tensor: new (type: "float32" | "int64", data: Float32Array | BigInt64Array, dims: number[]) => unknown;
  InferenceSession: {
    create(path: string): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
      release?(): Promise<void>;
    }>;
  };
}

export interface Vad {
  /** 0–1: how likely this frame is speech. */
  probability(frame: Int16Array): Promise<number>;
  /** Forget the state between utterances. */
  reset(): void;
}

const CONTEXT = 64;
const STATE_SIZE = 2 * 1 * 128;

export async function createSileroVad(modelPath: string, ort?: OrtLike, sampleRate = 16_000): Promise<Vad> {
  // require, not import(): the bundle is CommonJS and the module sits in the (unpacked) asar.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rt = ort ?? (require("onnxruntime-node") as OrtLike);
  const session = await rt.InferenceSession.create(modelPath);
  const sr = new rt.Tensor("int64", BigInt64Array.from([BigInt(sampleRate)]), []);
  let state: Float32Array = new Float32Array(STATE_SIZE);
  let context: Float32Array = new Float32Array(CONTEXT);

  return {
    async probability(frame) {
      const input = new Float32Array(CONTEXT + frame.length);
      input.set(context);
      for (let i = 0; i < frame.length; i++) input[CONTEXT + i] = frame[i] / 32768;
      context = input.slice(input.length - CONTEXT);
      const out = await session.run({
        input: new rt.Tensor("float32", input, [1, input.length]),
        state: new rt.Tensor("float32", state, [2, 1, 128]),
        sr,
      });
      state = out.stateN.data as Float32Array;
      return (out.output.data as Float32Array)[0] ?? 0;
    },
    reset() {
      state = new Float32Array(STATE_SIZE);
      context = new Float32Array(CONTEXT);
    },
  };
}

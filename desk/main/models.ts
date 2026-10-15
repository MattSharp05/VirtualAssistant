// The voice models (ADR 0004): too big to bundle, so they download on first run into the app's
// Application Support folder (userData/models), from revision-pinned Hugging Face URLs, with progress
// for the first-run card and a SHA-256 check. An interrupted download keeps its `.part` file and
// resumes with a Range request. No Electron in here: tested with a fake fetch.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ModelSpec {
  id: "whisper" | "silero";
  /** For the first-run card. */
  label: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

export const WHISPER_MODEL: ModelSpec = {
  id: "whisper",
  label: "Whisper base.en",
  file: "ggml-base.en.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
  bytes: 147_964_211,
  sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
};

export const SILERO_MODEL: ModelSpec = {
  id: "silero",
  label: "Silero VAD",
  file: "silero-vad.onnx",
  url: "https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx",
  bytes: 2_243_022,
  sha256: "a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808",
};

/** Smallest first, so the VAD is ready while Whisper is still coming. */
export const VOICE_MODELS: readonly ModelSpec[] = [SILERO_MODEL, WHISPER_MODEL];

export interface DownloadProgress {
  /** Bytes on disk across all the models (finished ones count in full). */
  done: number;
  total: number;
  /** The model being fetched now. */
  current: ModelSpec;
}

export interface EnsureOptions {
  fetch?: typeof fetch;
  onProgress?(progress: DownloadProgress): void;
  /** Tries per model; each retry resumes from the `.part` file. */
  attempts?: number;
  signal?: AbortSignal;
}

export class ChecksumError extends Error {}

const exists = async (path: string) => {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

async function hashFile(path: string): Promise<ReturnType<typeof createHash>> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash;
}

/**
 * One request: continues `<file>.part` if there is one (Range), else starts it. Resolves once the
 * whole file is there; throws (keeping the `.part`) if the connection drops.
 */
async function downloadOnce(
  spec: ModelSpec,
  part: string,
  opts: EnsureOptions,
  progress: (bytes: number) => void,
): Promise<ReturnType<typeof createHash>> {
  const doFetch = opts.fetch ?? fetch;
  let have = (await exists(part)) ?? 0;
  if (have >= spec.bytes) {
    // Already all there from an earlier try (or too long: start over).
    if (have === spec.bytes) return hashFile(part);
    await rm(part, { force: true });
    have = 0;
  }
  const res = await doFetch(spec.url, {
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.status === 416) {
    // The server can't continue what we have: throw it away and let the next try start fresh.
    await rm(part, { force: true });
    throw new Error(`${spec.label}: the partial download didn't match; starting over`);
  }
  if (!res.ok || !res.body) throw new Error(`${spec.label}: download failed (HTTP ${res.status})`);
  // 206 continues the part; a 200 means the server ignored the Range and sent it all again.
  const resumed = res.status === 206 && have > 0;
  const hash = resumed ? await hashFile(part) : createHash("sha256");
  if (!resumed) have = 0;
  const fh = await open(part, resumed ? "a" : "w");
  try {
    progress(have);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await fh.write(chunk);
      hash.update(chunk);
      have += chunk.byteLength;
      progress(have);
    }
  } finally {
    await fh.close();
  }
  return hash;
}

/**
 * The model's path in `dir`, downloading it first if needed. A finished file of the right size is
 * trusted (it was checked when it arrived); a download that doesn't match the SHA-256 is deleted.
 */
export async function ensureModel(
  spec: ModelSpec,
  dir: string,
  opts: EnsureOptions = {},
  progress: (bytes: number) => void = () => {},
): Promise<string> {
  const path = join(dir, spec.file);
  if ((await exists(path)) === spec.bytes) {
    progress(spec.bytes);
    return path;
  }
  await mkdir(dir, { recursive: true });
  const part = `${path}.part`;
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    let hash: ReturnType<typeof createHash>;
    try {
      hash = await downloadOnce(spec, part, opts, progress);
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
      continue;
    }
    const size = (await exists(part)) ?? 0;
    const digest = hash.digest("hex");
    if (size !== spec.bytes || digest !== spec.sha256) {
      await rm(part, { force: true });
      throw new ChecksumError(
        `${spec.label} didn't download correctly (checksum mismatch); it'll try again next time.`,
      );
    }
    await rename(part, path);
    return path;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Every voice model, one after the other, with one progress figure across them. */
export async function ensureModels(
  dir: string,
  opts: EnsureOptions = {},
  specs: readonly ModelSpec[] = VOICE_MODELS,
): Promise<Record<ModelSpec["id"], string>> {
  const total = specs.reduce((sum, s) => sum + s.bytes, 0);
  const paths = {} as Record<ModelSpec["id"], string>;
  let before = 0;
  for (const spec of specs) {
    paths[spec.id] = await ensureModel(spec, dir, opts, (bytes) =>
      opts.onProgress?.({ done: before + bytes, total, current: spec }),
    );
    before += spec.bytes;
  }
  return paths;
}

/** True when every model is already on disk (no first-run card needed). */
export async function modelsReady(dir: string, specs: readonly ModelSpec[] = VOICE_MODELS): Promise<boolean> {
  for (const spec of specs) if ((await exists(join(dir, spec.file))) !== spec.bytes) return false;
  return true;
}

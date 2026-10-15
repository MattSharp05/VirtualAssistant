// MediaPipe's files for Camera hands (JD-42, ADR 0012), bundled with the renderer: the WASM runtime
// (from the pinned @mediapipe/tasks-vision package) and the hand landmarker model, downloaded once
// into this folder (git-ignored) and checked against its sha256. A Vite plugin copies them next to
// index.html as mediapipe/*, where features/hands/tracker.ts loads them.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const MODEL = {
  file: "hand_landmarker.task",
  url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  sha256: "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
};

/** The SIMD build: Electron's Chromium (and every current browser) has WASM SIMD. */
export const WASM_FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm"];

const HERE = fileURLToPath(new URL(".", import.meta.url));

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The model's path in `dir`, downloading it first unless a verified copy is already there. */
export async function ensureModel(dir = HERE, fetchImpl: typeof fetch = fetch): Promise<string> {
  const path = join(dir, MODEL.file);
  const have = await readFile(path).catch(() => undefined);
  if (have && sha256(have) === MODEL.sha256) return path;
  const res = await fetchImpl(MODEL.url);
  if (!res.ok) throw new Error(`${MODEL.url}: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const got = sha256(body);
  if (got !== MODEL.sha256) throw new Error(`${MODEL.file}: sha256 ${got}, expected ${MODEL.sha256}`);
  await mkdir(dir, { recursive: true });
  await writeFile(`${path}.part`, body);
  await rename(`${path}.part`, path);
  return path;
}

/**
 * Copies the WASM runtime and the model into `<outDir>/mediapipe/`. Required for the app's build; the
 * web preview's build only warns without them (e.g. offline), since only Camera hands needs them.
 */
export function mediapipeAssets(opts: { required: boolean }): Plugin {
  let outDir = "dist";
  return {
    name: "jarvis-mediapipe-assets",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      try {
        const target = join(outDir, "mediapipe");
        await mkdir(target, { recursive: true });
        const require = createRequire(import.meta.url);
        for (const f of WASM_FILES)
          await copyFile(require.resolve(`@mediapipe/tasks-vision/${f}`), join(target, f));
        await copyFile(await ensureModel(), join(target, MODEL.file));
      } catch (err) {
        if (opts.required) throw err;
        this.warn(`Camera hands won't work in this build: ${(err as Error).message}`);
      }
    },
  };
}

// Files dropped on the orb or a window (JD-40, ADR 0009): main checks them (type, ≤ 20 MB), turns HEIC
// into JPEG with macOS `sips`, and posts them to POST /api/desk/files as multipart, reporting progress
// as the body is sent. No Electron in here, so it's tested with a fake fetch, files and converter.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { UploadResponse } from "@jarvis/shared";
import { checkFile, FILE_TYPES, fileExtension } from "../renderer/app/files";
import { ServerError, type ConnectionConfig } from "./connection";

/** How much of the body goes per progress step. */
export const UPLOAD_CHUNK = 256 * 1024;

/** What the preload sends: a dropped file's path on disk, or its bytes when it has none. */
export interface UploadSource {
  name: string;
  path?: string;
  bytes?: Uint8Array;
}

export interface UploaderOptions {
  config(): ConnectionConfig;
  fetch?: typeof fetch;
  readFile?(path: string): Promise<Uint8Array>;
  size?(path: string): Promise<number>;
  /** HEIC → JPEG bytes (macOS `sips` by default). */
  toJpeg?(path: string): Promise<Uint8Array>;
  timeoutMs?: number;
}

/** `sips -s format jpeg` into a temp folder, read back and cleaned up. */
export async function sipsToJpeg(path: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-heic-"));
  const out = join(dir, "converted.jpg");
  try {
    await new Promise<void>((resolve, reject) =>
      execFile("/usr/bin/sips", ["-s", "format", "jpeg", path, "--out", out], (err) =>
        err ? reject(new Error(`Couldn't convert ${basename(path)} to JPEG.`)) : resolve(),
      ),
    );
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** "IMG_0042.HEIC" → "IMG_0042.jpg". */
export const jpegName = (name: string) => `${name.replace(/\.[^.]+$/, "")}.jpg`;

/** A multipart/form-data body with one "file" field, as chunks, and its boundary. */
export function multipart(
  name: string,
  type: string,
  bytes: Uint8Array,
  boundary = `----jarvis${Math.random().toString(36).slice(2)}`,
): { boundary: string; parts: Uint8Array[]; length: number } {
  const enc = new TextEncoder();
  // Quotes and line breaks would end the header early.
  const safe = name.replace(/["\r\n]/g, "_");
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const parts: Uint8Array[] = [head];
  for (let i = 0; i < bytes.length; i += UPLOAD_CHUNK) parts.push(bytes.subarray(i, i + UPLOAD_CHUNK));
  parts.push(tail);
  return { boundary, parts, length: head.length + bytes.length + tail.length };
}

export class Uploader {
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: UploaderOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  /** Checks, converts and uploads one file; onProgress gets 0…1 (1 once the server has it). */
  async upload(source: UploadSource, onProgress?: (fraction: number) => void): Promise<UploadResponse> {
    const { serverUrl, deviceKey } = this.opts.config();
    if (!serverUrl || !deviceKey)
      throw new Error("Not connected to JARVIS yet: add the server URL and a device key in Settings.");
    let name = basename(String(source.name || (source.path ? basename(source.path) : "file")));
    const size = source.path
      ? await (this.opts.size ?? (async (p) => (await stat(p)).size))(source.path)
      : (source.bytes?.length ?? 0);
    const problem = checkFile({ name, size });
    if (problem) throw new Error(problem);

    let bytes: Uint8Array;
    if (fileExtension(name) === "heic") {
      if (!source.path) throw new Error(`Couldn't convert ${name} to JPEG: save it to a file first.`);
      bytes = await (this.opts.toJpeg ?? sipsToJpeg)(source.path);
      name = jpegName(name);
      const after = checkFile({ name, size: bytes.length });
      if (after) throw new Error(after);
    } else if (source.path) {
      bytes = new Uint8Array(await (this.opts.readFile ?? readFile)(source.path));
    } else {
      bytes = source.bytes ?? new Uint8Array();
    }

    const { boundary, parts, length } = multipart(name, FILE_TYPES[fileExtension(name)]!, bytes);
    let sent = 0;
    let next = 0;
    onProgress?.(0);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[next++];
        if (!part) return controller.close();
        controller.enqueue(part);
        sent += part.length;
        // The last few bytes are the server's to confirm: 1 only arrives with its answer.
        onProgress?.(Math.min(0.99, sent / length));
      },
    });
    const res = await this.fetch(`${serverUrl}/api/desk/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceKey}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      duplex: "half",
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    } as RequestInit);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok)
      throw new ServerError(res.status, (json as { error?: string } | undefined)?.error ?? res.statusText);
    onProgress?.(1);
    return json as UploadResponse;
  }
}

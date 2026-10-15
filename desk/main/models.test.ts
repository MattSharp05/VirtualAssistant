// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChecksumError,
  ensureModel,
  ensureModels,
  modelsReady,
  type DownloadProgress,
  type ModelSpec,
} from "./models";

const content = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 31 + 7) % 256));
const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  id: "silero",
  label: "Test model",
  file: "model.bin",
  url: "https://models.test/model.bin",
  bytes: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
  ...over,
});

/** A body that sends `bytes` in 4 KB chunks, then fails if `dropAfter` is set. */
function body(bytes: Buffer, dropAfter?: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (dropAfter !== undefined && at >= dropAfter) return c.error(new Error("socket hang up"));
      if (at >= bytes.length) return c.close();
      const end = Math.min(bytes.length, at + 4096, dropAfter ?? Infinity);
      c.enqueue(new Uint8Array(bytes.subarray(at, end)));
      at = end;
    },
  });
}

interface Server {
  fetch: typeof fetch;
  ranges: (string | undefined)[];
}

/** A fake model host: honours Range (unless told not to), can drop the first N connections midway. */
function server(
  data: Buffer,
  opts: { dropFirst?: number; dropAt?: number; ignoreRange?: boolean } = {},
): Server {
  const ranges: (string | undefined)[] = [];
  let calls = 0;
  const fake = async (_url: string | URL | Request, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    ranges.push(range);
    const drop = calls++ < (opts.dropFirst ?? 0) ? (opts.dropAt ?? data.length / 2) : undefined;
    const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    if (from >= data.length) return new Response(null, { status: 416 });
    const slice = data.subarray(from);
    return new Response(body(slice, drop === undefined ? undefined : Math.max(0, drop - from)), {
      status: from > 0 ? 206 : 200,
    });
  };
  return { fetch: fake as typeof fetch, ranges };
}

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-models-"));

describe("ensureModel", () => {
  it("downloads, checks the SHA-256 and moves the file into place", async () => {
    const dir = tmp();
    const host = server(content);
    const seen: number[] = [];
    const path = await ensureModel(spec(), dir, { fetch: host.fetch }, (b) => seen.push(b));
    expect(path).toBe(join(dir, "model.bin"));
    expect(readFileSync(path).equals(content)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(content.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("resumes an interrupted download with a Range request", async () => {
    const dir = tmp();
    const host = server(content, { dropFirst: 1, dropAt: 20_000 });
    const path = await ensureModel(spec(), dir, { fetch: host.fetch });
    expect(host.ranges).toEqual([undefined, "bytes=20000-"]);
    expect(readFileSync(path).equals(content)).toBe(true);
  });

  it("resumes a .part left by an earlier run (the app quit mid-download)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "model.bin.part"), content.subarray(0, 12_345));
    const host = server(content);
    const path = await ensureModel(spec(), dir, { fetch: host.fetch });
    expect(host.ranges).toEqual(["bytes=12345-"]);
    expect(readFileSync(path).equals(content)).toBe(true);
  });

  it("starts over when the server ignores the Range and sends everything", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "model.bin.part"), content.subarray(0, 1000));
    const host = server(content, { ignoreRange: true });
    const path = await ensureModel(spec(), dir, { fetch: host.fetch });
    expect(readFileSync(path).equals(content)).toBe(true);
  });

  it("rejects a file whose checksum doesn't match, and deletes it", async () => {
    const dir = tmp();
    const tampered = Buffer.from(content);
    tampered[100] ^= 0xff;
    await expect(ensureModel(spec(), dir, { fetch: server(tampered).fetch })).rejects.toBeInstanceOf(
      ChecksumError,
    );
    expect(existsSync(join(dir, "model.bin"))).toBe(false);
    expect(existsSync(join(dir, "model.bin.part"))).toBe(false);
  });

  it("gives up after its attempts, keeping the .part for next time", async () => {
    const dir = tmp();
    const host = server(content, { dropFirst: 5, dropAt: 8192 });
    await expect(ensureModel(spec(), dir, { fetch: host.fetch, attempts: 2 })).rejects.toThrow(
      "socket hang up",
    );
    expect(readFileSync(join(dir, "model.bin.part")).length).toBe(8192);
  });

  it("doesn't download a model that's already there", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "model.bin"), content);
    const host = server(content);
    await ensureModel(spec(), dir, { fetch: host.fetch });
    expect(host.ranges).toEqual([]);
  });

  it("reports an HTTP error", async () => {
    const fail = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(ensureModel(spec(), tmp(), { fetch: fail, attempts: 1 })).rejects.toThrow("HTTP 404");
  });
});

describe("ensureModels", () => {
  it("fetches each model with one progress figure across them all", async () => {
    const dir = tmp();
    const second = Buffer.from(content.subarray(0, 10_000));
    const specs = [
      spec(),
      spec({
        id: "whisper",
        file: "w.bin",
        url: "https://models.test/w.bin",
        bytes: second.length,
        sha256: createHash("sha256").update(second).digest("hex"),
      }),
    ];
    const hosts: Record<string, Server> = { "model.bin": server(content), "w.bin": server(second) };
    const fetchBoth = ((url: string, init?: RequestInit) =>
      hosts[url.split("/").pop()!].fetch(url, init)) as typeof fetch;
    const progress: DownloadProgress[] = [];
    expect(await modelsReady(dir, specs)).toBe(false);
    const paths = await ensureModels(dir, { fetch: fetchBoth, onProgress: (p) => progress.push(p) }, specs);
    expect(paths).toEqual({ silero: join(dir, "model.bin"), whisper: join(dir, "w.bin") });
    expect(progress.at(-1)).toMatchObject({ done: 60_000, total: 60_000 });
    expect(progress.at(-1)!.current.id).toBe("whisper");
    expect(await modelsReady(dir, specs)).toBe(true);
  });
});

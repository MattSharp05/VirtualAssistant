// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureModel, MODEL } from "./assets";

const response = (body: string, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 404,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }) as Response;

describe("ensureModel", () => {
  it("refuses a download whose sha256 doesn't match, and keeps nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-"));
    const fetchImpl = vi.fn(async () => response("not the model"));
    await expect(ensureModel(dir, fetchImpl)).rejects.toThrow(/sha256/);
    expect(fetchImpl).toHaveBeenCalledWith(MODEL.url);
    await expect(readFile(join(dir, MODEL.file))).rejects.toThrow();
  });

  it("fails on an HTTP error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-"));
    await expect(ensureModel(dir, async () => response("", false))).rejects.toThrow(/HTTP 404/);
  });

  it("downloads again over a corrupt copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-"));
    await writeFile(join(dir, MODEL.file), "truncated");
    const fetchImpl = vi.fn(async () => response("still wrong"));
    await expect(ensureModel(dir, fetchImpl)).rejects.toThrow(/sha256/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

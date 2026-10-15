// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FS_MAX_FILE_BYTES, FS_MAX_LIST_ENTRIES, type RpcAnswer } from "@jarvis/shared";
import { FsRefused, MacFiles, patternToRegExp } from "./fs";
import { answerRpc } from "./index";

let base: string;
let notes: string;
let secret: string;
let allowed: string[];
let files: MacFiles;

beforeEach(() => {
  // realpath: macOS's /var → /private/var, so expectations compare real paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-fs-")));
  notes = join(base, "Documents", "Notes");
  secret = join(base, "Secret");
  mkdirSync(join(notes, "Trips"), { recursive: true });
  mkdirSync(join(notes, ".private"), { recursive: true });
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(notes, "Trips", "lisbon trip.md"), "Flights on the 12th");
  writeFileSync(join(notes, "groceries.txt"), "eggs");
  writeFileSync(join(notes, ".DS_Store"), "x");
  writeFileSync(join(notes, ".private", "diary.md"), "dear diary");
  writeFileSync(join(notes, "app.exe"), "MZ");
  writeFileSync(join(secret, "passwords.txt"), "hunter2");
  symlinkSync(join(secret, "passwords.txt"), join(notes, "sneaky.txt"));
  symlinkSync(secret, join(notes, "SecretLink"));
  symlinkSync(join(notes, "groceries.txt"), join(notes, "list.txt"));
  allowed = [notes];
  files = new MacFiles({ allowedFolders: () => allowed, home: base });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const refused = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);

describe("path checks", () => {
  it("accepts files inside an allowed folder, ~ included", async () => {
    expect((await files.resolve(join(notes, "Trips", "lisbon trip.md"))).path).toBe(
      join(notes, "Trips", "lisbon trip.md"),
    );
    expect((await files.resolve("~/Documents/Notes/groceries.txt")).root).toBe(notes);
  });

  it("refuses .. even when it would land back inside", async () => {
    await refused(files.resolve(`${notes}/../../Secret/passwords.txt`), /climbs out with "\.\."/);
    await refused(files.resolve(`${notes}/Trips/../groceries.txt`), /"\.\."/);
  });

  it("refuses symlinks pointing outside the allowed folders", async () => {
    await refused(files.resolve(join(notes, "sneaky.txt")), /outside the folders/);
    await refused(files.resolve(join(notes, "SecretLink", "passwords.txt")), /outside the folders/);
    await expect(files.read({ path: join(notes, "sneaky.txt") })).rejects.toBeInstanceOf(FsRefused);
    // A link that stays inside is fine.
    expect((await files.read({ path: join(notes, "list.txt") })).name).toBe("groceries.txt");
  });

  it("refuses absolute paths outside and relative paths", async () => {
    await refused(files.resolve(join(secret, "passwords.txt")), /outside the folders/);
    await refused(files.resolve("/etc/passwd"), /outside the folders/);
    await refused(files.resolve("groceries.txt"), /isn't a full path/);
    await refused(files.resolve(""), /full path/);
    await refused(files.resolve(join(notes, "missing.md")), /There's no/);
  });

  it("refuses a sibling folder that only shares the prefix", async () => {
    mkdirSync(`${notes}-old`);
    writeFileSync(`${notes}-old/a.txt`, "a");
    await refused(files.resolve(`${notes}-old/a.txt`), /outside the folders/);
  });

  it("refuses hidden files and folders", async () => {
    await refused(files.resolve(join(notes, ".DS_Store")), /hidden/);
    await refused(files.resolve(join(notes, ".private", "diary.md")), /hidden/);
  });

  it("refuses everything when no folder is allowed, and follows Settings changes at once", async () => {
    allowed = [];
    await refused(files.resolve(join(notes, "groceries.txt")), /No folders are allowed yet/);
    allowed = [secret];
    expect((await files.read({ path: join(secret, "passwords.txt") })).name).toBe("passwords.txt");
  });
});

describe("fs.read", () => {
  it("returns the file as base64", async () => {
    const out = await files.read({ path: join(notes, "Trips", "lisbon trip.md") });
    expect(out).toEqual({
      name: "lisbon trip.md",
      size: 19,
      data: Buffer.from("Flights on the 12th").toString("base64"),
    });
  });

  it("refuses oversize files with a clear message", async () => {
    writeFileSync(join(notes, "big.pdf"), Buffer.alloc(3 * 1024 * 1024));
    await refused(
      files.read({ path: join(notes, "big.pdf") }),
      /big\.pdf is 3 MB; JARVIS reads files up to 2 MB/,
    );
    writeFileSync(join(notes, "ok.pdf"), Buffer.alloc(FS_MAX_FILE_BYTES));
    expect((await files.read({ path: join(notes, "ok.pdf") })).size).toBe(FS_MAX_FILE_BYTES);
  });

  it("refuses unsupported kinds and folders with a clear message", async () => {
    await refused(
      files.read({ path: join(notes, "app.exe") }),
      /reads text, markdown, CSV\/JSON, PDFs and images.*not \.exe/,
    );
    await refused(files.read({ path: join(notes, "Trips") }), /is a folder/);
  });
});

describe("fs.list", () => {
  it("without a folder lists the allowed folders", async () => {
    expect(await files.list({})).toEqual({ entries: [{ path: notes, type: "folder" }], truncated: false });
  });

  it("lists recursively, skipping hidden entries and links that lead outside", async () => {
    const out = await files.list({ folder: notes });
    expect(out.folder).toBe(notes);
    expect(out.truncated).toBe(false);
    expect(out.entries.map((e) => e.path.slice(notes.length + 1))).toEqual([
      "app.exe",
      "groceries.txt",
      "list.txt",
      "Trips",
      "Trips/lisbon trip.md",
    ]);
    const trip = out.entries.find((e) => e.path.endsWith("lisbon trip.md"))!;
    expect(trip).toMatchObject({ type: "file", size: 19 });
    expect(Date.parse(trip.modified!)).toBeGreaterThan(0);
  });

  it("filters by a case-insensitive pattern", async () => {
    const out = await files.list({ folder: "~/Documents/Notes", pattern: "*TRIP*" });
    expect(out.entries.map((e) => e.path)).toEqual([
      join(notes, "Trips"),
      join(notes, "Trips", "lisbon trip.md"),
    ]);
    expect(patternToRegExp("a?.md").test("ab.md")).toBe(true);
    expect(patternToRegExp("a?.md").test("abmd")).toBe(false);
  });

  it(`stops at ${FS_MAX_LIST_ENTRIES} entries and says so`, async () => {
    const many = join(notes, "Many");
    mkdirSync(many);
    for (let i = 0; i < FS_MAX_LIST_ENTRIES + 5; i++) writeFileSync(join(many, `n${i}.txt`), "");
    const out = await files.list({ folder: many });
    expect(out.entries).toHaveLength(FS_MAX_LIST_ENTRIES);
    expect(out.truncated).toBe(true);
  });

  it("refuses folders outside and files", async () => {
    await refused(files.list({ folder: secret }), /outside the folders/);
    await refused(files.list({ folder: join(notes, "SecretLink") }), /outside the folders/);
    await refused(files.list({ folder: join(notes, "groceries.txt") }), /is a file/);
  });
});

describe("answerRpc", () => {
  it("answers with the handler's result, or its refusal, at /rpc/:id", async () => {
    const send = vi.fn<(path: string, answer: RpcAnswer) => Promise<unknown>>(async () => ({ ok: true }));
    const handlers = { "fs.read": (p: unknown) => files.read(p as { path: string }) };
    await answerRpc(
      { type: "rpc", id: "r1", kind: "fs.read", payload: { path: join(notes, "groceries.txt") } },
      handlers,
      send,
    );
    expect(send).toHaveBeenLastCalledWith("/rpc/r1", {
      ok: true,
      result: { name: "groceries.txt", size: 4, data: Buffer.from("eggs").toString("base64") },
    });
    await answerRpc(
      { type: "rpc", id: "r2", kind: "fs.read", payload: { path: "/etc/passwd" } },
      handlers,
      send,
    );
    expect(send.mock.lastCall?.[1]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/outside the folders/),
    });
    await answerRpc({ type: "rpc", id: "r3", kind: "clipboard.read", payload: {} }, handlers, send);
    expect(send).toHaveBeenLastCalledWith("/rpc/r3", {
      ok: false,
      error: "This Desk can't do clipboard.read yet.",
    });
  });

  it("doesn't throw when the answer can't be delivered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async () => {
      throw new Error("no such request (answered or timed out)");
    });
    await expect(
      answerRpc({ type: "rpc", id: "x", kind: "nope", payload: null }, {}, send),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

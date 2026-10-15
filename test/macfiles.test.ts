import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FS_MAX_FILE_BYTES, type DeskEvent, type RpcAnswer } from "@jarvis/shared";
import { systemPrompt } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import { DeskRpc } from "../src/desk/rpc.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import macfiles, { NOT_CONNECTED } from "../src/tools/macfiles.js";
import { uploadsDir } from "../src/uploads.js";

type Rpc = Extract<DeskEvent, { type: "rpc" }>;

/** A fake Desk on the live stream: answers each rpc with `answer` (as POST /rpc/:id would). */
function context(clients: number, answer: (e: Rpc) => RpcAnswer) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-macfiles-"));
  const bus = new EventBus();
  const rpc = new DeskRpc(bus, 1000);
  const asked: Rpc[] = [];
  bus.subscribe((e) => {
    if (e.type !== "rpc") return;
    asked.push(e);
    setImmediate(() => rpc.answer(e.id, answer(e)));
  });
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  const desk = { bus, rpc, hub: { clientCount: clients } } as unknown as DeskContext;
  return { ctx: { jarvis, config: jarvis.config, desk }, asked, dir };
}

const tool = (name: string) => macfiles.tools.find((t) => t.name === name)!;
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

test("mac_read asks the Mac for the file, saves it as an upload and returns the path to Read", async () => {
  const { ctx, asked, dir } = context(1, () => ({ ok: true, result: { name: "lisbon trip.md", size: 19, data: b64("Flights on the 12th") } }));
  const out = await tool("mac_read").handler({ path: " ~/Documents/Notes/Trips/lisbon trip.md " }, ctx);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "fs.read");
  assert.deepEqual(asked[0].payload, { path: "~/Documents/Notes/Trips/lisbon trip.md" });
  const path = /Read (\S.*) to see it\.$/.exec(out)?.[1];
  assert.ok(path, out);
  assert.ok(path.startsWith(uploadsDir(dir)), path);
  assert.ok(path.endsWith("lisbon trip.md"));
  assert.equal(readFileSync(path, "utf8"), "Flights on the 12th");
});

test("the Mac's refusals reach the brain as tool errors", async () => {
  const { ctx } = context(1, () => ({ ok: false, error: "/etc/passwd is outside the folders JARVIS may read (~/Documents/Notes)." }));
  await assert.rejects(tool("mac_read").handler({ path: "/etc/passwd" }, ctx), /outside the folders JARVIS may read/);
  await assert.rejects(tool("mac_list").handler({ folder: "/etc" }, ctx), /outside the folders/);
});

test("oversize and unsupported files are refused with a clear message", async () => {
  const big = context(1, () => ({ ok: true, result: { name: "huge.pdf", size: FS_MAX_FILE_BYTES + 1, data: b64(Buffer.alloc(FS_MAX_FILE_BYTES + 1)) } }));
  await assert.rejects(tool("mac_read").handler({ path: "/Users/m/Notes/huge.pdf" }, big.ctx), /huge\.pdf is over 2 MB/);
  const exe = context(1, () => ({ ok: true, result: { name: "app.exe", size: 2, data: b64("MZ") } }));
  await assert.rejects(tool("mac_read").handler({ path: "/Users/m/Notes/app.exe" }, exe.ctx), /not \.exe/);
  await assert.rejects(tool("mac_read").handler({ path: "  " }, exe.ctx), /full path/);
});

test("mac_list shows the allowed folders, or a folder's files with size and date", async () => {
  const { ctx, asked } = context(1, (e) =>
    (e.payload as { folder?: string }).folder
      ? {
          ok: true,
          result: {
            folder: "/Users/m/Documents/Notes",
            entries: [
              { path: "/Users/m/Documents/Notes/Trips", type: "folder", modified: "2026-10-01T10:00:00.000Z" },
              { path: "/Users/m/Documents/Notes/Trips/lisbon trip.md", type: "file", size: 2048, modified: "2026-10-02T10:00:00.000Z" },
            ],
            truncated: true,
          },
        }
      : { ok: true, result: { entries: [{ path: "/Users/m/Documents/Notes", type: "folder" }], truncated: false } },
  );
  assert.equal(await tool("mac_list").handler({}, ctx), "Folders JARVIS may read on the Mac:\n- /Users/m/Documents/Notes");
  assert.deepEqual(asked[0].payload, {});
  const out = await tool("mac_list").handler({ folder: "/Users/m/Documents/Notes", pattern: "*trip*" }, ctx);
  assert.deepEqual(asked[1].payload, { folder: "/Users/m/Documents/Notes", pattern: "*trip*" });
  assert.match(out, /^\/Users\/m\/Documents\/Notes:\n- \/Users\/m\/Documents\/Notes\/Trips\/\n- .*lisbon trip\.md \(2 KB, modified 2026-10-02\)/);
  assert.match(out, /Only the first 2 are shown/);
});

test("mac_list with no allowed folders points at Settings → Folders", async () => {
  const { ctx } = context(1, () => ({ ok: true, result: { entries: [], truncated: false } }));
  assert.match(await tool("mac_list").handler({}, ctx), /Settings → Folders/);
});

test("with no Desk connected both tools say the Mac isn't connected and ask nothing", async () => {
  const { ctx, asked } = context(0, () => ({ ok: true, result: {} }));
  await assert.rejects(tool("mac_list").handler({}, ctx), { message: NOT_CONNECTED });
  await assert.rejects(tool("mac_read").handler({ path: "/x.md" }, ctx), /Mac isn't connected/);
  const { desk: _desk, ...withoutDesk } = ctx;
  await assert.rejects(tool("mac_read").handler({ path: "/x.md" }, withoutDesk), /Mac isn't connected/);
  assert.equal(asked.length, 0);
});

test("the tools are registered and their hint is in the system prompt", async () => {
  const { ctx } = context(0, () => ({ ok: true, result: {} }));
  const registry = await ToolRegistry.discover();
  assert.ok(registry.has("mac_list") && registry.has("mac_read"));
  assert.match(systemPrompt(await registry.brainSetup(ctx)), /mac_read copies one file over/);
});

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.js";
import { DeviceStore } from "../src/desk/auth.js";
import { DeskRouter, type DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import { MAX_UPLOAD_BYTES, safeName, UploadStore, uploadsDir } from "../src/uploads.js";
import { createDashboard } from "../src/web.js";
import { Brain } from "../src/brain/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-uploads-"));

test("the brain's CLI gets Read limited to the uploads folder and no other built-in tool", async () => {
  const dir = tmp();
  const config = { dataDir: dir, brainConnectors: [] } as unknown as Config;
  const setup = await (await ToolRegistry.discover()).brainSetup({ jarvis: new Jarvis(config, new Store(dir)), config });
  assert.deepEqual(setup.builtinTools, ["Read"]);
  assert.deepEqual(setup.allowRules, [`Read(/${uploadsDir(dir)}/**)`]);
  assert.ok(setup.allowRules![0].startsWith("Read(//"), "absolute path rule (leading //)");

  // The assembled command line (fake CLI logs its argv).
  const log = join(dir, "argv.json");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();process.stdin.on("end",()=>console.log('{"type":"result","result":"ok","usage":{}}'));\n`);
  chmodSync(bin, 0o755);
  const brain = new Brain({ claudeBin: bin, dataDir: dir, models: ["m"], defaultModel: "m", internalUrl: "http://127.0.0.1:1", internalToken: "t", warm: false, setup: async () => setup }, new Store(dir));
  await brain.chat("summarise this", "telegram", { attachments: [{ path: `${uploadsDir(dir)}/abc/report.pdf`, name: "report.pdf" }] });
  const argv = JSON.parse(readFileSync(log, "utf8")) as string[];
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  assert.equal(flag("--tools"), "Read", "Read is the only built-in");
  assert.deepEqual(JSON.parse(flag("--settings")), { permissions: { allow: [`Read(/${uploadsDir(dir)}/**)`] } });
  assert.equal(flag("--add-dir"), uploadsDir(dir));
});

test("attached files are named in the user message", async () => {
  const dir = tmp();
  const bin = join(dir, "claude");
  const prompt = join(dir, "prompt.txt");
  writeFileSync(bin, `#!/bin/sh\ncat > ${prompt}\necho '{"type":"result","result":"ok","usage":{}}'\n`);
  chmodSync(bin, 0o755);
  const brain = new Brain({ claudeBin: bin, dataDir: dir, models: ["m"], defaultModel: "m", internalUrl: "http://127.0.0.1:1", internalToken: "t", warm: false }, new Store(dir));
  await brain.chat("summarise this", "telegram", { attachments: [{ path: "/data/uploads/abc/report.pdf", name: "report.pdf" }] });
  assert.match(readFileSync(prompt, "utf8"), /summarise this\nAttached: \/data\/uploads\/abc\/report\.pdf \(report\.pdf\)$/);
});

test("names are sanitised, types and sizes checked, old uploads cleaned up", () => {
  assert.equal(safeName("../../etc/passwd.txt"), "passwd.txt");
  assert.equal(safeName("..\\\\..\\\\win.ini.txt"), "win.ini.txt");
  assert.equal(safeName("my report (final).pdf"), "my report _final_.pdf");
  assert.equal(safeName("...hidden.md"), "hidden.md");
  assert.equal(safeName("../"), "file");

  const dir = tmp();
  const store = new UploadStore(dir);
  const up = store.save("../../evil.txt", new TextEncoder().encode("hello"));
  assert.ok(up.path.startsWith(join(uploadsDir(dir), up.id) + "/"), "stays inside its folder");
  assert.equal(up.name, "evil.txt");
  assert.equal(readFileSync(up.path, "utf8"), "hello");
  assert.deepEqual(store.get(up.id), up);
  assert.equal(store.get("../x"), undefined);
  assert.throws(() => store.save("run.sh", new Uint8Array(1)), /not \.sh/);
  assert.throws(() => store.save("big.pdf", new Uint8Array(MAX_UPLOAD_BYTES + 1)), /up to 20 MB/);

  const old = store.save("old.md", new Uint8Array(1));
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60_000) / 1000;
  utimesSync(join(uploadsDir(dir), old.id), eightDaysAgo, eightDaysAgo);
  assert.equal(store.cleanup(), 1);
  assert.ok(!existsSync(old.path) && existsSync(up.path));
  assert.equal(store.cleanup(Date.now() + 8 * 24 * 60 * 60_000), 1, "everything goes once it's 7 days old (fake clock)");
});

test("POST /api/desk/files saves a multipart upload; over 20 MB is 413", async (t) => {
  const dir = tmp();
  const jarvis = new Jarvis({ dataDir: dir } as unknown as Config, new Store(dir));
  const devices = new DeviceStore(dir);
  const { key } = await devices.pair("Mac");
  const ctx = { jarvis, devices, bus: new EventBus() } as unknown as DeskContext;
  const server = createDashboard(jarvis, { desk: { router: await DeskRouter.discover(), ctx } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desk/files`;
  const auth = { authorization: `Bearer ${key}` };

  const form = new FormData();
  form.append("file", new Blob(["# Notes\nhello"], { type: "text/markdown" }), "../notes.md");
  const res = await fetch(url, { method: "POST", headers: auth, body: form });
  assert.equal(res.status, 200);
  const up = (await res.json()) as { id: string; path: string; name: string };
  assert.equal(up.name, "notes.md");
  assert.equal(readFileSync(up.path, "utf8"), "# Notes\nhello");

  // Over 20 MB: refused from the Content-Length header, before the body is read.
  const bigStatus = await new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...auth, "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_UPLOAD_BYTES + 100_000) } }, (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    });
    req.on("error", reject);
    req.write("x");
  });
  assert.equal(bigStatus, 413);
  const wrong = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  assert.equal(wrong.status, 400);
});

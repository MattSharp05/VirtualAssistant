import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import { DeviceStore } from "../src/desk/auth.js";
import { DeskRpc } from "../src/desk/rpc.js";
import { DeskRouter, type DeskContext } from "../src/desk/routes/index.js";
import { SseHub } from "../src/desk/sse.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { createDashboard } from "../src/web.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-desk-"));

function config(dataDir: string): Config {
  return {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined,
    reportsPort: 0, notionToken: undefined, brainModels: ["claude-haiku-5-5"], brainModel: "claude-haiku-5-5", brainWarm: false, brainConnectors: [],
  };
}

async function start(rpcTimeoutMs = 30_000) {
  const dir = tmp();
  const jarvis = new Jarvis(config(dir), new Store(dir));
  const bus = new EventBus();
  const ctx: DeskContext = { jarvis, bus, devices: new DeviceStore(dir), hub: new SseHub(bus), rpc: new DeskRpc(bus, rpcTimeoutMs) };
  const server = createDashboard(jarvis, { desk: { router: await DeskRouter.discover(), ctx } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = () => {
    ctx.hub.close();
    server.closeAllConnections();
    server.close();
  };
  return { dir, ctx, base, stop };
}

/** Opens the SSE stream and collects `data:` payloads (and ids) until closed. */
function openStream(base: string, key: string, lastEventId?: string) {
  const events: { id: number; data: Record<string, unknown> }[] = [];
  let close = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    const req = request(`${base}/api/desk/events`, { headers: { authorization: `Bearer ${key}`, ...(lastEventId ? { "last-event-id": lastEventId } : {}) } }, (res) => {
      assert.equal(res.statusCode, 200);
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (\d+)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (id && data) events.push({ id: Number(id[1]), data: JSON.parse(data[1]) });
        }
      });
      resolve();
    });
    req.on("error", reject);
    req.end();
    close = () => req.destroy();
  });
  return { events, ready, close: () => close() };
}

const waitFor = async (cond: () => boolean, ms = 1000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("pairing gives a key that works, is never stored in plain text, and stops working once revoked", async () => {
  const { dir, ctx, base, stop } = await start();
  try {
    assert.deepEqual(await (await fetch(`${base}/api/desk/health`)).json(), { ok: true, protocol: PROTOCOL_VERSION });
    // Pairing is a dashboard action.
    const paired = await (await fetch(`${base}/api/desk-devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "MacBook Pro" }) })).json();
    const key = paired.key as string;
    assert.match(key, /^jd_/);
    const me = await fetch(`${base}/api/desk/me`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).name, "MacBook Pro");
    assert.equal((await fetch(`${base}/api/desk/me`)).status, 401);
    assert.equal((await fetch(`${base}/api/desk/me`, { headers: { authorization: "Bearer jd_wrong" } })).status, 401);
    assert.ok(!readFileSync(join(dir, "devices.json"), "utf8").includes(key), "the key itself is never stored");
    const listed = await (await fetch(`${base}/api/desk-devices`)).json();
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0].hash, undefined, "the hash isn't exposed either");
    await fetch(`${base}/api/desk-devices/${paired.device.id}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal((await fetch(`${base}/api/desk/me`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
    assert.equal(ctx.devices.list().length, 0);
  } finally {
    stop();
  }
});

test("events on the bus reach a connected Desk quickly, and a reconnect catches up from Last-Event-ID", async () => {
  const { ctx, base, stop } = await start();
  try {
    const { key } = await ctx.devices.pair("Mac");
    const first = openStream(base, key);
    await first.ready;
    await waitFor(() => ctx.hub.clientCount === 1);
    const t0 = Date.now();
    ctx.bus.publish({ type: "orb.state", state: "thinking" });
    await waitFor(() => first.events.length === 1, 1000);
    assert.ok(Date.now() - t0 < 100, "delivered within 100 ms");
    const lastId = first.events[0].id;
    first.close();
    await waitFor(() => ctx.hub.clientCount === 0);
    ctx.bus.publish({ type: "orb.state", state: "speaking" });
    ctx.bus.publish({ type: "orb.state", state: "idle" });
    const second = openStream(base, key, String(lastId));
    await second.ready;
    await waitFor(() => second.events.length === 2);
    assert.deepEqual(second.events.map((e) => e.data.state), ["speaking", "idle"]);
    second.close();
  } finally {
    stop();
  }
});

test("a server→Mac request resolves when the Desk answers and fails after the timeout", async () => {
  const { ctx, base, stop } = await start(200);
  try {
    const { key } = await ctx.devices.pair("Mac");
    const seen: { id: string; kind: string }[] = [];
    ctx.bus.subscribe((e) => {
      if (e.type === "rpc") seen.push(e);
    });
    const pending = ctx.rpc.call("clipboard.read", {});
    await waitFor(() => seen.length === 1);
    const res = await fetch(`${base}/api/desk/rpc/${seen[0].id}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ok: true, result: "copied text" }) });
    assert.equal(res.status, 200);
    assert.equal(await pending, "copied text");
    // Answering twice: the request is gone.
    assert.equal((await fetch(`${base}/api/desk/rpc/${seen[0].id}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" })).status, 404);
    await assert.rejects(ctx.rpc.call("screen.capture", {}), /didn't answer/);
    // An error answer rejects with the Mac's message.
    const failing = assert.rejects(ctx.rpc.call("fs.read", { path: "/x" }), /outside allowed folders/);
    await waitFor(() => seen.length === 3);
    await fetch(`${base}/api/desk/rpc/${seen[2].id}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ok: false, error: "outside allowed folders" }) });
    await failing;
  } finally {
    stop();
  }
});

test("unknown Desk routes are 404 and wrong methods 405", async () => {
  const { ctx, base, stop } = await start();
  try {
    const { key } = await ctx.devices.pair("Mac");
    const auth = { authorization: `Bearer ${key}` };
    assert.equal((await fetch(`${base}/api/desk/nope`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/api/desk/me`, { method: "POST", headers: auth, body: "{}" })).status, 405);
    // A body that isn't JSON is a clean 400, not a server error.
    assert.equal((await fetch(`${base}/api/desk/rpc/x`, { method: "POST", headers: auth, body: "not json" })).status, 400);
  } finally {
    stop();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../src/config.js";
import { Jarvis } from "../src/jarvis.js";
import { SessionStarter } from "../src/sessionStart.js";
import { Store } from "../src/store.js";
import { parseUsageResponse } from "../src/usage.js";
import { createDashboard, createReportsServer } from "../src/web.js";
import { MAX_UPLOAD_BYTES, uploadsDir } from "../src/uploads.js";
import type { Brain } from "../src/brain/index.js";

const config: Config = {
  telegramBotToken: undefined,
  allowedChatId: undefined,
  routineId: undefined,
  routineToken: undefined,
  dataDir: mkdtempSync(join(tmpdir(), "jarvis-web-")),
  claudeBin: "/bin/false", // every CLI call fails fast: status reads "not logged in"
  dashboardPort: 0,
  dashboardPassword: "pw",
  reportSecret: "s3cret",
  reportsPort: 0, notionToken: undefined, brainModels: ["claude-sonnet-5-5"], brainModel: "claude-sonnet-5-5", brainWarm: false, brainConnectors: [],
};
const store = new Store(config.dataDir);
const jarvis = new Jarvis(config, store);
// No claude.ai login here (an empty config folder), so new jobs never reach the real sessions API.
jarvis.starter = new SessionStarter(config, { configDir: mkdtempSync(join(tmpdir(), "jarvis-web-login-")) });
const server = createDashboard(jarvis);
let base = "";
const auth = { authorization: "Basic " + Buffer.from("me:pw").toString("base64") };

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test("dashboard requires the password", async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  const page = await fetch(`${base}/`, { headers: auth });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>JARVIS<\/title>/);
});

test("reports need the report secret, then show up in state", async () => {
  const post = (authorization: string) =>
    fetch(`${base}/api/reports`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ job: "J1", text: "done: PR #1" }),
    });
  assert.equal((await post("Bearer wrong")).status, 401);
  assert.equal((await post("Bearer s3cret")).status, 201);

  const state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    reports: { jobId: string; text: string }[];
    status: { auth: { loggedIn: boolean }; routineConfigured: boolean; usage: { available: boolean } };
  };
  assert.equal(state.reports[0].jobId, "j1");
  assert.equal(state.reports[0].text, "done: PR #1");
  assert.equal(state.status.auth.loggedIn, false);
  assert.equal(state.status.routineConfigured, false);
  assert.equal(state.status.usage.available, false);
});

test("starting a job without a routine is a clear 400", async () => {
  const res = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ task: "x" }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /No routine configured/);
});

test("non-JSON posts are refused (blocks cross-site form posts)", async () => {
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: auth, body: "task=x" });
  assert.equal(res.status, 400);
});

test("parseUsageResponse reads both windows and both spellings", () => {
  const parsed = parseUsageResponse({
    subscription_type: "max",
    rate_limits: {
      five_hour: { utilization: 42.5, resets_at: "2026-10-12T23:00:00Z" },
      seven_day: { used_percentage: 120, resets_at: 1792000000 },
    },
  });
  assert.equal(parsed.available, true);
  assert.deepEqual(parsed.windows[0], { name: "five_hour", percent: 42.5, resetsAt: "2026-10-12T23:00:00Z" });
  assert.equal(parsed.windows[1].percent, 100);
  assert.equal(parsed.windows[1].resetsAt, new Date(1792000000 * 1000).toISOString());
  assert.equal(parseUsageResponse({ rate_limits_available: false, rate_limits: null }).available, false);
});

test("POST /api/uploads saves a multipart file; over 20 MB is 413, other types 400", async () => {
  const url = `${base}/api/uploads`;
  const headers = { ...auth, "x-jarvis-upload": "1" };
  const form = new FormData();
  form.append("file", new Blob(["# Notes\nhello"], { type: "text/markdown" }), "../notes.md");
  const res = await fetch(url, { method: "POST", headers, body: form });
  assert.equal(res.status, 200);
  const up = (await res.json()) as { id: string; path: string; name: string };
  assert.equal(up.name, "notes.md");
  assert.match(up.id, /^[0-9a-f]{12}$/);
  assert.ok(up.path.startsWith(uploadsDir(config.dataDir)));
  assert.equal(readFileSync(up.path, "utf8"), "# Notes\nhello");

  // Over 20 MB: refused from the Content-Length header, before the body is read.
  const bigStatus = await new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_UPLOAD_BYTES + 100_000) } }, (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    });
    req.on("error", reject);
    req.write("x");
  });
  assert.equal(bigStatus, 413);

  const wrong = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  assert.equal(wrong.status, 400);
  assert.match(((await wrong.json()) as { error: string }).error, /multipart\/form-data/);

  const exe = new FormData();
  exe.append("file", new Blob(["echo hi"]), "run.sh");
  const badType = await fetch(url, { method: "POST", headers, body: exe });
  assert.equal(badType.status, 400);
  assert.match(((await badType.json()) as { error: string }).error, /not \.sh/);

  // Without the dashboard's own header (what a cross-site form post would look like): refused.
  const crossSite = await fetch(url, { method: "POST", headers: auth, body: form });
  assert.equal(crossSite.status, 400);
  assert.equal((await fetch(url, { method: "POST", headers: { "x-jarvis-upload": "1" }, body: form })).status, 401, "needs the password");
});

test("POST /api/brain/chat passes uploads to the brain as attachments", async (t) => {
  const calls: { message: string; channel: string; attachments?: { id?: string; path: string; name: string }[] }[] = [];
  const brain = {
    model: "m",
    models: ["m"],
    chat: async (message: string, channel: string, opts: { onDelta?: (d: string) => void; attachments?: { path: string; name: string }[] } = {}) => {
      calls.push({ message, channel, attachments: opts.attachments });
      opts.onDelta?.("ok");
      return { reply: "ok" };
    },
  } as unknown as Brain;
  const dash = createDashboard(jarvis, { brain });
  await new Promise<void>((resolve) => dash.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    dash.closeAllConnections();
    dash.close();
  });
  const url = `http://127.0.0.1:${(dash.address() as AddressInfo).port}`;
  const chat = (body: unknown) =>
    fetch(`${url}/api/brain/chat`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

  const form = new FormData();
  form.append("file", new Blob(["a,b\n1,2"]), "data.csv");
  const up = (await (await fetch(`${url}/api/uploads`, { method: "POST", headers: { ...auth, "x-jarvis-upload": "1" }, body: form })).json()) as {
    id: string;
    path: string;
    name: string;
  };

  // No attachments: exactly as before.
  assert.equal((await chat({ message: "hi" })).status, 200);
  assert.deepEqual(calls[0], { message: "hi", channel: "dashboard", attachments: [] });

  assert.equal((await chat({ message: "what's in this?", attachments: [up.id] })).status, 200);
  assert.deepEqual(calls[1], { message: "what's in this?", channel: "dashboard", attachments: [up] });

  // Streamed, too.
  const streamed = await chat({ message: "and now?", stream: true, attachments: [up.id] });
  assert.equal(streamed.status, 200);
  assert.match(await streamed.text(), /"done"/);
  assert.deepEqual(calls[2].attachments, [up]);

  for (const stream of [false, true]) {
    const missing = await chat({ message: "this one?", stream, attachments: ["0123456789ab"] });
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: string }).error, "No upload 0123456789ab (they're kept for 7 days).");
  }
  assert.equal(calls.length, 3, "an unknown upload never reaches the brain");
});

test("the public reports server accepts reports and exposes nothing else", async () => {
  const reports = createReportsServer(store, "s3cret");
  await new Promise<void>((resolve) => reports.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(reports.address() as AddressInfo).port}`;
  try {
    assert.match(await (await fetch(`${url}/`)).text(), /reports endpoint is up/);
    for (const path of ["/api/state", "/api/system", "/api/jobs"]) {
      const res = await fetch(url + path, { headers: auth });
      assert.equal(res.status, 404, `${path} must not be reachable from the internet`);
    }
    const post = (authorization: string) =>
      fetch(`${url}/api/reports`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ job: "j9", text: "via funnel" }),
      });
    assert.equal((await post("Bearer nope")).status, 401);
    assert.equal((await post("Bearer s3cret")).status, 201);
    assert.equal(store.recentReports(1)[0].text, "via funnel");
  } finally {
    reports.closeAllConnections();
    reports.close();
  }
});

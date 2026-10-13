import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../src/config.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { parseUsageResponse } from "../src/usage.js";
import { createDashboard, createReportsServer } from "../src/web.js";

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
  reportsPort: 0, notionToken: undefined, brainModels: ["claude-sonnet-5-5"], brainModel: "claude-sonnet-5-5",
};
const store = new Store(config.dataDir);
const server = createDashboard(new Jarvis(config, store));
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

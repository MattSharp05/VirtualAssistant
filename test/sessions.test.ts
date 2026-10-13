import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.js";
import { Jarvis, JarvisError } from "../src/jarvis.js";
import { followUpText } from "../src/prompts.js";
import { parseSessionId, Store } from "../src/store.js";
import { createReportsServer } from "../src/web.js";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-sessions-"));
  const config = {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined,
    reportSecret: "s3cret-s3cret-s3cret-s3cret", reportsPort: 0,
  } satisfies Config;
  const store = new Store(dataDir);
  return { store, jarvis: new Jarvis(config, store), dataDir };
}

test("parseSessionId accepts links and bare IDs in both formats", () => {
  assert.equal(parseSessionId("https://claude.ai/code/session_01ABC?from=cli&m=0"), "session_01ABC");
  assert.equal(parseSessionId("claude.ai/code/cse_01LWuUJPnEfBbaSiaPtrrPqf"), "cse_01LWuUJPnEfBbaSiaPtrrPqf");
  assert.equal(parseSessionId("cse_01XYZ"), "cse_01XYZ");
  assert.equal(parseSessionId("https://claude.ai/code"), undefined);
});

test("attachSession validates the link and the name", () => {
  const { jarvis } = setup();
  const job = jarvis.attachSession("https://claude.ai/code/cse_01MK", "MK", "Mario Kart orchestrator");
  assert.deepEqual([job.id, job.sessionId, job.kind, job.task], ["mk", "cse_01MK", "attached", "Mario Kart orchestrator"]);
  assert.throws(() => jarvis.attachSession("not a link", "x"), JarvisError);
  assert.throws(() => jarvis.attachSession("cse_01A", "j7"), /Names are/); // j-numbers are JARVIS's own
  assert.throws(() => jarvis.attachSession("cse_01A", "has space"), /Names are/);
  assert.throws(() => jarvis.attachSession("cse_01B", "mk"), /already a job called mk/);
  jarvis.forget("mk");
  assert.equal(jarvis.store.getJob("mk"), undefined);
  assert.throws(() => jarvis.forget("mk"), /No job mk/);
});

test("a report with a session adds an orchestrator, and a successor takes the name over", () => {
  const { store, dataDir } = setup();
  store.addReport("mk", "Batch 3 started", "cse_01FIRST");
  assert.deepEqual(
    [store.getJob("mk")?.kind, store.getJob("mk")?.sessionId, store.getJob("mk")?.url],
    ["reported", "cse_01FIRST", "https://claude.ai/code/cse_01FIRST"],
  );
  store.addReport("mk", "MK-74 merged", "cse_01FIRST");
  assert.equal(store.getJob("mk")?.sessionUpdatedAt, undefined, "same session: nothing moves");
  store.addReport("mk", "Taking over from the previous orchestrator", "cse_01SECOND");
  const reloaded = new Store(dataDir);
  assert.equal(reloaded.getJob("mk")?.sessionId, "cse_01SECOND");
  assert.ok(reloaded.getJob("mk")?.sessionUpdatedAt);
  assert.equal(reloaded.recentReports(5).length, 3);
  // Without a session, a report is just stored: no job appears out of nowhere.
  store.addReport("nobody", "hello");
  assert.equal(store.getJob("nobody"), undefined);
});

test("the public reports endpoint passes the sender's session through", async () => {
  const { store } = setup();
  const server = createReportsServer(store, "s3cret-s3cret-s3cret-s3cret");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reports`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer s3cret-s3cret-s3cret-s3cret", "content-type": "application/json" },
      body: JSON.stringify({ job: "sm", text: "ShapeMint batch done", session: "https://api.anthropic.com/v1/code/sessions/cse_01SM" }),
    });
    assert.equal(res.status, 201);
    assert.equal(store.getJob("sm")?.sessionId, "cse_01SM");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("follow-ups tell external sessions to use the plugin's reporter", () => {
  const at = new Date("2026-10-13T20:00:00.000Z");
  assert.match(followUpText("j1", "go", at), /report back with scripts\/report\.sh j1/);
  const ext = followUpText("mk", "go", at, true);
  assert.match(ext, /<workflow plugin>\/scripts\/jarvis_report\.sh mk 2026-10-13T20:00:00\.000Z/);
  assert.match(ext, /just answer in this session/);
});

test("recentJobs puts the most recently active first", () => {
  const { store } = setup();
  store.addJob({ id: "j1", sessionId: "s1", url: "u", task: "old", createdAt: "2026-01-01T00:00:00.000Z", kind: "started" });
  store.addJob({ id: "j2", sessionId: "s2", url: "u", task: "newer", createdAt: "2026-02-01T00:00:00.000Z", kind: "started" });
  store.addReport("j1", "fresh report"); // j1 is now the most recently active
  assert.deepEqual(store.recentJobs().map((j) => j.id), ["j1", "j2"]);
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authStatus, sendToSession } from "../src/cloud.js";
import { followUpText, newJobText } from "../src/prompts.js";
import { fireRoutine, RoutineError } from "../src/routines.js";
import { Store } from "../src/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-test-"));

/** A fake `claude` binary: records argv and stdin, prints the given stdout. */
function fakeClaude(stdout: string, exitCode = 0): { bin: string; log: string } {
  const dir = tmp();
  const bin = join(dir, "claude");
  const log = join(dir, "log");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" > ${log}\ncat >> ${log}\nprintf '%s\\n' '${stdout}'\nexit ${exitCode}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

test("fireRoutine posts the documented request and returns the session", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        type: "routine_fire",
        claude_code_session_id: "session_01ABC",
        claude_code_session_url: "https://claude.ai/code/session_01ABC",
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await fireRoutine("trig_123", "sk-ant-oat01-x", "do the thing", fakeFetch);
  assert.deepEqual(result, { sessionId: "session_01ABC", url: "https://claude.ai/code/session_01ABC" });
  assert.equal(seen?.url, "https://api.anthropic.com/v1/claude_code/routines/trig_123/fire");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-ant-oat01-x");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(seen?.init.body as string), { text: "do the thing" });
});

test("fireRoutine explains rate limiting", async () => {
  const fakeFetch = (async () =>
    new Response("{}", { status: 429, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
  await assert.rejects(fireRoutine("trig_1", "t", "x", fakeFetch), (err: RoutineError) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /retry after 120s/);
    return true;
  });
});

test("sendToSession passes the message on stdin, not argv", async () => {
  const { bin, log } = fakeClaude('{"ok":true,"session_id":"session_1","url":"u"}');
  const result = await sendToSession(bin, "session_1", "--dangerous looking text");
  assert.deepEqual(result, { ok: true, sessionId: "session_1", url: "u", error: undefined });
  const { readFileSync } = await import("node:fs");
  const [argv, stdin] = readFileSync(log, "utf8").split("\n");
  assert.equal(argv, "-p --cloud session_1 --output-format json");
  assert.equal(stdin, "--dangerous looking text");
});

test("sendToSession surfaces non-JSON errors", async () => {
  const { bin } = fakeClaude("Cloud sessions need a claude.ai sign-in.", 1);
  const result = await sendToSession(bin, "session_1", "hi");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /claude.ai sign-in/);
});

test("authStatus warns when signed in with a setup-token", async () => {
  const { bin } = fakeClaude('{"loggedIn":true,"authMethod":"oauth_token"}');
  const status = await authStatus(bin);
  assert.equal(status.loggedIn, true);
  assert.match(status.warning ?? "", /claude auth login/);
});

test("store tracks jobs, the current job and fires in the last hour", () => {
  const dir = tmp();
  const store = new Store(dir);
  const id = store.newJobId();
  store.addJob({ id, sessionId: "s1", url: "u", task: "t", createdAt: new Date().toISOString() });
  store.touch(id);
  const now = new Date();
  store.recordFire(new Date(now.getTime() - 61 * 60_000)); // older than an hour
  store.recordFire(now);

  const reloaded = new Store(dir);
  assert.equal(reloaded.currentJob()?.id, "j1");
  assert.equal(reloaded.getJob("J1")?.messagesSent, 1);
  assert.equal(reloaded.firesInLastHour(now).length, 1);
  assert.equal(reloaded.newJobId(), "j2");
});

test("prompts carry the job id and send time", () => {
  const at = new Date("2026-10-12T20:00:00.000Z");
  assert.match(newJobText("j1", " fix it ", at), /JARVIS job: j1\nSent at: 2026-10-12T20:00:00.000Z[\s\S]*fix it$/);
  assert.match(followUpText("j1", "and this", at), /~\/jarvis-report\.sh j1 2026-10-12T20:00:00\.000Z/);
});

test("a CLI that exits without reading stdin doesn't crash JARVIS", async () => {
  const dir = tmp();
  const bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  const big = "x".repeat(1 << 20); // larger than the pipe buffer, so the write really hits EPIPE
  const result = await sendToSession(bin, "session_1", big);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not logged in/);
});

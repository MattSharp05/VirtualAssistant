import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketOf, countEvent, emptyTally, parseDetail, SessionMetricsSource } from "../src/sessionMetrics.js";

const T0 = Date.parse("2026-10-17T08:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** The live detail shape (checked 2026-10-17), trimmed. */
const detail = (over: Record<string, unknown> = {}) => ({
  id: "session_01MK",
  tags: ["jarvis", "orchestrator"],
  status_bucket: "SESSION_STATUS_BUCKET_WORKING",
  created_at: at(0),
  updated_at: at(50),
  configured_model: "model-configured",
  lineage: { depth: 1, parent_session_id: "session_01PARENT" },
  external_metadata: {
    usage: { cache_read_tokens: 820_538_750, cache_write_tokens: 8_315_652, cost_usd: 269.76, input_tokens: 98_498, output_tokens: 2_654_189 },
    context_usage: { max_tokens: 1_000_000, used_tokens: 270_674 },
    last_served_model: "model-served",
    task_summary: "Building MK-81",
  },
  ...over,
});

const user = (id: string, min: number, text: string) => ({ id, created_at: at(min), data: { type: "user", message: { role: "user", content: text } } });
const toolUse = (id: string, min: number, n = 1) => ({
  id,
  created_at: at(min),
  data: { type: "assistant", message: { content: Array.from({ length: n }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: "Bash" })) } },
});
const toolResult = (id: string, min: number, text: string) => ({
  id,
  created_at: at(min),
  data: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t0", content: [{ type: "text", text }] }] } },
});
const result = (id: string, min: number) => ({ id, created_at: at(min), data: { type: "result", subtype: "success", result: "done" } });

/** A fake sessions API: detail per session, events oldest first, paged like the session tool's list_events. */
function fakeApi(opts: { details: Record<string, unknown>; events: Record<string, Record<string, unknown>[]>; page?: number }) {
  const calls: string[] = [];
  let failing = false;
  const page = opts.page ?? 3;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (failing) return json({ error: "boom" }, 503);
    const m = url.pathname.match(/^\/v1\/code\/sessions\/([^/]+)(\/events)?$/);
    if (!m) return json({}, 404);
    const id = decodeURIComponent(m[1]);
    if (!m[2]) return opts.details[id] ? json(opts.details[id]) : json({ error: "not found" }, 404);
    const all = opts.events[id] ?? [];
    const idx = (eid: string | null) => all.findIndex((e) => e.id === eid);
    let slice: Record<string, unknown>[];
    let hasMore: boolean;
    if (url.searchParams.get("after_id")) {
      const from = idx(url.searchParams.get("after_id")) + 1;
      slice = all.slice(from, from + page);
      hasMore = from + page < all.length;
    } else {
      const to = url.searchParams.get("before_id") ? idx(url.searchParams.get("before_id")) : all.length;
      slice = all.slice(Math.max(0, to - page), to);
      hasMore = to - page > 0;
    }
    return json({ data: slice, first_id: slice[0]?.id ?? null, last_id: slice.at(-1)?.id ?? null, has_more: hasMore });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    fail: (v: boolean) => (failing = v),
  };
}

function source(api: ReturnType<typeof fakeApi>, clock: { now: number }) {
  return new SessionMetricsSource({ fetchImpl: api.fetchImpl, token: () => "tok", organizationUuid: () => "org", now: () => clock.now });
}

test("parseDetail reads usage, context, models, status, tags, lineage and times", () => {
  const d = parseDetail(detail());
  assert.equal(d.inputTokens, 98_498);
  assert.equal(d.outputTokens, 2_654_189);
  assert.equal(d.cacheReadTokens, 820_538_750);
  assert.equal(d.cacheWriteTokens, 8_315_652);
  assert.equal(d.totalTokens, 98_498 + 2_654_189 + 820_538_750 + 8_315_652);
  assert.equal(d.costUsd, 269.76);
  assert.equal(d.contextPercent, 27.1);
  assert.equal(d.model, "model-served", "the served model beats the configured one");
  assert.equal(d.configuredModel, "model-configured", "the configured one is kept when they differ");
  assert.equal(parseDetail(detail({ configured_model: "model-served" })).configuredModel, undefined, "and dropped when they match");
  assert.equal(d.statusBucket, "working");
  assert.deepEqual(d.tags, ["jarvis", "orchestrator"]);
  assert.equal(d.parentId, "session_01PARENT");
  assert.equal(d.createdAt, at(0));
  assert.equal(bucketOf("SESSION_STATUS_BUCKET_REVIEW_READY"), "review_ready");
});

test("parseDetail: a session without usage leaves everything unknown, never 0", () => {
  const d = parseDetail({ id: "session_01OLD", created_at: at(0), external_metadata: { usage: { input_tokens: 5 } } });
  assert.deepEqual(d, { inputTokens: 5, createdAt: at(0) }, "only known keys, and no total from a partial usage");
  assert.deepEqual(parseDetail(null), {});
  assert.deepEqual(parseDetail({ external_metadata: { context_usage: { used_tokens: 10, max_tokens: 0 } } }), { contextUsedTokens: 10, contextMaxTokens: 0 });
});

test("countEvent: turns are real user messages, tool calls are tool_use blocks, PRs come from tool results, active time runs start → result", () => {
  const t = emptyTally();
  for (const e of [
    user("e1", 0, "Build MK-81"),
    toolUse("e2", 1, 2),
    toolResult("e3", 2, "Created https://github.com/MattSharp05/mk/pull/81 ok"),
    toolResult("e4", 3, "again https://github.com/MattSharp05/mk/pull/81"),
    result("e5", 10),
    { id: "e6", created_at: at(20), data: { type: "user", message: { content: "hook noise" } }, isSynthetic: true },
    { id: "e7", created_at: at(30), data: { user: { message: { content: [{ type: "text", text: "and MK-82" }] } } } },
    toolUse("e8", 31),
  ])
    countEvent(t, e);
  assert.equal(t.turns, 2, "synthetic messages and tool results aren't turns; a kind-keyed event is read too");
  assert.equal(t.toolCalls, 3);
  assert.deepEqual(t.prs, ["https://github.com/MattSharp05/mk/pull/81"]);
  assert.equal(t.activeMs, 10 * 60_000);
  assert.equal(t.openTurnAt, at(30), "the second turn is still open");
});

test("list summary and full metrics; the second read fetches only new events; cached for 60 s", async () => {
  const events = [user("e1", 0, "Build MK-81"), toolUse("e2", 1), toolResult("e3", 2, "https://github.com/o/r/pull/1"), result("e4", 10), user("e5", 20, "next"), toolUse("e6", 21), result("e7", 25)];
  const api = fakeApi({ details: { session_01MK: detail() }, events: { session_01MK: events } });
  const clock = { now: T0 + 60 * 60_000 };
  const src = source(api, clock);

  const row = await src.summary("session_01MK");
  assert.equal(row?.costUsd, 269.76);
  assert.equal(row?.wallMs, 60 * 60_000, "a running session's wall time runs to now");
  assert.equal(row?.turns, undefined, "rows carry no activity");
  assert.deepEqual(api.calls, ["/v1/code/sessions/session_01MK"]);

  const full = await src.full("session_01MK");
  assert.equal(full?.turns, 2);
  assert.equal(full?.toolCalls, 2);
  assert.deepEqual(full?.prs, ["https://github.com/o/r/pull/1"]);
  assert.equal(full?.activeMs, 15 * 60_000);
  assert.equal(full?.activityPartial, undefined);
  // First read: the newest page, then back with before_id until the start (pages of 3).
  assert.deepEqual(api.calls.slice(1), [
    "/v1/code/sessions/session_01MK/events?limit=100",
    "/v1/code/sessions/session_01MK/events?limit=100&before_id=e5",
    "/v1/code/sessions/session_01MK/events?limit=100&before_id=e2",
  ]);

  // Within 60 s nothing is read again.
  api.calls.length = 0;
  clock.now += 30_000;
  await src.full("session_01MK");
  assert.deepEqual(api.calls, []);

  // New events arrive; the next read asks only for what came after e7.
  events.push(user("e8", 61, "and PR 2"), toolResult("e9", 62, "https://github.com/o/r/pull/2"), result("e10", 64));
  clock.now += 31_000;
  const again = await src.full("session_01MK");
  assert.deepEqual(api.calls, ["/v1/code/sessions/session_01MK", "/v1/code/sessions/session_01MK/events?limit=100&after_id=e7"]);
  assert.equal(again?.turns, 3);
  assert.deepEqual(again?.prs, ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
  assert.equal(again?.activeMs, 18 * 60_000);
});

test("an API error keeps the last good metrics; a session without usage is unknown, not 0", async () => {
  const api = fakeApi({ details: { session_01MK: detail(), session_01OLD: { id: "session_01OLD", created_at: at(0) } }, events: {} });
  const clock = { now: T0 + 60_000 };
  const src = source(api, clock);
  const first = await src.full("session_01MK");
  assert.equal(first?.turns, 0, "an empty but readable history is 0 turns");

  api.fail(true);
  clock.now += 61_000;
  const kept = await src.full("session_01MK");
  assert.equal(kept?.costUsd, 269.76);
  assert.equal(kept?.checkedAt, first?.checkedAt, "checkedAt says how old they are");

  api.fail(false);
  const old = await src.summary("session_01OLD");
  assert.equal(old?.costUsd, undefined);
  assert.equal(old?.totalTokens, undefined);
  assert.equal(old?.contextPercent, undefined);
  assert.equal(await src.summary("session_01NOPE"), undefined, "a 404 detail gives no metrics");
  assert.equal(await new SessionMetricsSource({ fetchImpl: api.fetchImpl, token: () => undefined }).summary("session_01MK"), undefined, "no login, no calls");
});

test("a completed session: wall time stops at its last activity and it's never read again", async () => {
  const done = detail({ status_bucket: "SESSION_STATUS_BUCKET_COMPLETED", updated_at: at(40) });
  const api = fakeApi({ details: { session_01MK: done }, events: { session_01MK: [user("e1", 0, "go"), result("e2", 30)] } });
  const clock = { now: T0 + 5 * 3600_000 };
  const src = source(api, clock);
  const m = await src.full("session_01MK");
  assert.equal(m?.finished, true);
  assert.equal(m?.wallMs, 40 * 60_000);
  assert.equal(m?.activeMs, 30 * 60_000);
  const n = api.calls.length;
  clock.now += 3600_000;
  await src.full("session_01MK");
  await src.summary("session_01MK");
  assert.equal(api.calls.length, n);
});

test("summaries fills a list a few at a time and skips unknown sessions", async () => {
  const api = fakeApi({ details: { a: detail({ id: "a" }), b: detail({ id: "b", external_metadata: {} }) }, events: {} });
  const src = source(api, { now: T0 });
  const out = await src.summaries(["a", "b", "c"]);
  assert.deepEqual([...out.keys()].sort(), ["a", "b"]);
  assert.equal(out.get("b")?.costUsd, undefined);
});

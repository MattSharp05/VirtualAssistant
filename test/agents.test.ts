import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentBuilder, AgentsResponse, DeskEvent, SessionMetrics } from "@jarvis/shared";
import { AgentGraph, useAgentGraph, type NotionReader } from "../src/agents/index.js";
import { CI_ACTIVE_MS, CI_IDLE_MS, checkState, ciState, CiPoller, parseCheckRuns } from "../src/agents/github.js";
import { buildGraph, changedIds, FOLD_AFTER_MS, parsePr, parseRunBlocks, parseTags, parseTicketRow, sessionRefs, signatures, type GraphInput, type GraphSession } from "../src/agents/graph.js";
import { parseProjects, type Config, type ProjectSetting } from "../src/config.js";
import { DeviceStore } from "../src/desk/auth.js";
import { DeskRpc } from "../src/desk/rpc.js";
import { DeskRouter, type DeskContext } from "../src/desk/routes/index.js";
import { SseHub } from "../src/desk/sse.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Notion } from "../src/notion.js";
import { Store } from "../src/store.js";
import { createDashboard } from "../src/web.js";

const NOW = Date.parse("2026-10-17T04:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const RUN = "3fc24983f3ca81aa0000000000000001";
const PROJECTS: ProjectSetting[] = [
  { slug: "jarvis", name: "JARVIS Desk", tickets: "collection://97df4bde-6ac0-42d6-a1cc-0b0838864dfb", repo: "MattSharp05/VirtualAssistant", prefix: "JD" },
  { slug: "trip", name: "Trip planner", repo: "MattSharp05/trip", prefix: "TR" },
];

function session(id: string, title: string, metrics: Partial<SessionMetrics> = {}, minutesAgo = 5): GraphSession {
  return { id, title, url: `https://claude.ai/code/${id}`, status: "running", lastActivity: ago(minutesAgo), metrics: { checkedAt: ago(0), ...metrics } };
}

function input(over: Partial<GraphInput>): GraphInput {
  return { sessions: [], projects: PROJECTS, runs: new Map(), tickets: new Map(), now: NOW, ...over };
}

const project = (tree: AgentsResponse, slug: string) => tree.projects.find((p) => p.slug === slug)!;
const ids = (list: AgentBuilder[]) => list.map((b) => b.id);

test("parsers: tags, session refs (cut short with …), PR numbers with the project's repo, projects setting", () => {
  assert.deepEqual(parseTags(["project:jarvis", "Role:Orchestrator", "run:3fc24983-f3ca-81aa-0000-000000000001", "junk", "ticket:"]), {
    project: "jarvis",
    role: "orchestrator",
    run: RUN,
  });
  const known = ["session_01AbCdEf", "session_01AbXyZ", "session_01Qq"];
  assert.deepEqual(sessionRefs("session_01Qq…", known), ["session_01Qq"]);
  assert.deepEqual(sessionRefs("session_01Ab…", known), [], "an ambiguous prefix matches nothing");
  assert.deepEqual(sessionRefs("https://claude.ai/code/session_01AbXyZ and session_01New", known), ["session_01AbXyZ", "session_01New"]);
  assert.deepEqual(parsePr("#63", "o/r"), { number: 63, url: "https://github.com/o/r/pull/63", repo: "o/r", state: "open" });
  assert.equal(parsePr("https://github.com/a/b/pull/7 (green)")?.repo, "a/b");
  assert.equal(parsePr("#63"), undefined, "a bare number needs a repo");
  assert.deepEqual(parseProjects('[{"slug":"jarvis","name":"JARVIS Desk","repo":"o/r"},{"slug":"x"}]'), [
    { slug: "jarvis", name: "JARVIS Desk", repo: "o/r" },
    { slug: "x", name: "x" },
  ]);
  assert.throws(() => parseProjects('[{"name":"no slug"}]'), /slug/);
  assert.throws(() => parseProjects("nope"), /JSON/);
});

test("tags only: orchestrator with its builders, a project-only session is loose, configured projects always show", () => {
  const tree = buildGraph(
    input({
      sessions: [
        session("session_O1", "JARVIS batch 13 orchestrator", { tags: ["project:jarvis", "role:orchestrator", `run:${RUN}`], costUsd: 4, totalTokens: 1000 }),
        session("session_B1", "Agent graph", { tags: ["project:jarvis", "role:builder", "orchestrator:session_O1", "ticket:JD-57", `run:${RUN}`], costUsd: 2.5, totalTokens: 500 }),
        session("session_B2", "Sessions metrics", { tags: ["project:jarvis", "role:builder", "orchestrator:session_O1", "ticket:JD-54"] }),
        session("session_L1", "Poke at the dashboard", { tags: ["project:jarvis"] }),
        session("session_X", "Unrelated chat"),
      ],
    }),
  );
  assert.deepEqual(
    tree.projects.map((p) => p.slug),
    ["jarvis", "trip"],
  );
  const jarvis = project(tree, "jarvis");
  assert.equal(jarvis.name, "JARVIS Desk");
  assert.equal(jarvis.orchestrators.length, 1);
  const o = jarvis.orchestrators[0];
  assert.equal(o.id, "session:session_O1");
  assert.equal(o.finished, false);
  assert.deepEqual(ids(o.builders), ["session:session_B2", "session:session_B1"], "sorted by ticket");
  assert.equal(o.builders[1].ticket?.id, "JD-57");
  assert.deepEqual(o.builders[1].sources, ["tags"]);
  assert.deepEqual(o.metrics, { sessions: 3, builders: 2, active: 2, costUsd: 6.5, totalTokens: 1500 });
  assert.deepEqual(ids(jarvis.loose), ["session:session_L1"]);
  assert.equal(jarvis.metrics.sessions, 4);
  assert.deepEqual(project(tree, "trip"), {
    id: "project:trip",
    slug: "trip",
    name: "Trip planner",
    repo: "MattSharp05/trip",
    metrics: { sessions: 0, builders: 0, active: 0 },
    orchestrators: [],
    loose: [],
    folded: 0,
  });
  assert.ok(!JSON.stringify(tree).includes("session_X"), "a session no source ties to a project is left out");
});

test("lineage only: sessions started by another hang under it; a title ticket gives the project", () => {
  const tree = buildGraph(
    input({
      sessions: [
        session("session_P", "Trip orchestrator"),
        session("session_C1", "TR-20: hotel search", { parentId: "session_P" }),
        session("session_C2", "Fix the map pins", { parentId: "session_P" }),
        // Started by a builder: it still works for the orchestrator.
        session("session_G", "Helper", { parentId: "session_C2" }),
      ],
    }),
  );
  const trip = project(tree, "trip");
  assert.equal(trip.orchestrators.length, 1);
  const o = trip.orchestrators[0];
  assert.equal(o.session.id, "session_P");
  assert.deepEqual(ids(o.builders), ["session:session_C1", "session:session_C2", "session:session_G"]);
  assert.deepEqual(o.builders[0].sources, ["lineage", "title"]);
  assert.equal(o.builders[0].ticket?.id, "TR-20");
});

test("run page: the Builders table adds sub-agents and fills gaps (ticket, state, PR, times)", () => {
  const cell = (t: string) => [{ plain_text: t }];
  const row = (...cells: string[]) => ({ block: { type: "table_row", table_row: { cells: cells.map(cell) } }, children: [] });
  const blocks = [
    { block: { type: "callout", callout: { rich_text: cell("Orchestrator: link · Started 03:00 · Status: Running") } }, children: [] },
    { block: { type: "heading_2", heading_2: { rich_text: cell("Now") } }, children: [] },
    { block: { type: "table" }, children: [row("Ticket", "Status"), row("JD-1", "x")] },
    { block: { type: "heading_2", heading_2: { rich_text: cell("Builders") } }, children: [] },
    {
      block: { type: "table" },
      children: [
        row("Ticket", "Kind", "Session / worktree", "State", "PR", "Started", "Updated"),
        row("JD-47", "sub-agent", "/home/user/va-jd47", "CI", "#63", "03:10", "03:52"),
        row("JD-48", "cloud session", "session_01Bb…", "building", "", "03:15", "03:40"),
        row("JD-49", "cloud session", "session_01Gone", "stopped", "", "03:20", "03:30"),
      ],
    },
  ];
  const run = parseRunBlocks(blocks);
  assert.equal(run.status, "Running");
  assert.equal(run.builders.length, 3);
  assert.deepEqual(run.builders[0], { ticket: "JD-47", kind: "sub-agent", who: "/home/user/va-jd47", state: "ci", pr: "#63", started: "03:10", updated: "03:52" });

  const tree = buildGraph(
    input({
      sessions: [
        session("session_01Orc", "Batch 12 orchestrator", { tags: ["project:jarvis", "role:orchestrator", `run:${RUN}`] }),
        // Untagged builder: only the table ties it to the orchestrator and to JD-48.
        session("session_01BbCc", "Window manager"),
      ],
      runs: new Map([[RUN, { id: RUN, url: `https://www.notion.so/${RUN}`, title: "Run: JARVIS batch 12 (2026-10-17)", status: run.status, date: "2026-10-17", builders: run.builders }]]),
    }),
  );
  const o = project(tree, "jarvis").orchestrators[0];
  assert.deepEqual(o.run, { id: RUN, url: `https://www.notion.so/${RUN}`, title: "Run: JARVIS batch 12 (2026-10-17)", status: "Running" });
  const [sub, cloud, gone] = o.builders;
  assert.equal(sub.kind, "sub-agent");
  assert.equal(sub.worktree, "/home/user/va-jd47");
  assert.equal(sub.pr?.url, "https://github.com/MattSharp05/VirtualAssistant/pull/63", "PR number + the project's repo");
  assert.equal(sub.startedAt, "2026-10-17T03:10:00.000Z");
  assert.equal(cloud.id, "session:session_01BbCc");
  assert.equal(cloud.ticket?.id, "JD-48");
  assert.equal(cloud.state, "building");
  assert.deepEqual(cloud.sources, ["run-page"]);
  assert.equal(gone.kind, "cloud");
  assert.equal(gone.session?.id, "session_01Gone", "a session the list doesn't show still gets its link");
  assert.equal(o.metrics.active, 2, "stopped doesn't count as active");
});

test("ticket pages, no tags: Sessions field ties a session to its ticket; an in-progress ticket alone still shows", () => {
  const prop = {
    id: (n: number) => ({ type: "unique_id", unique_id: { prefix: "JD", number: n } }),
    title: (t: string) => ({ type: "title", title: [{ plain_text: t }] }),
    status: (s: string) => ({ type: "status", status: { name: s } }),
    text: (t: string) => ({ type: "rich_text", rich_text: t ? [{ plain_text: t }] : [] }),
  };
  const rows = [
    { url: "https://www.notion.so/jd57", properties: { "Ticket ID": prop.id(57), Title: prop.title("Agent graph"), Status: prop.status("In Progress"), Sessions: prop.text("https://claude.ai/code/session_T1"), PR: prop.text(""), Branch: prop.text("jd-57") } },
    { url: "https://www.notion.so/jd58", properties: { "Ticket ID": prop.id(58), Title: prop.title("Agents window"), Status: prop.status("In Review"), Sessions: prop.text(""), PR: prop.text("https://github.com/MattSharp05/VirtualAssistant/pull/90"), Branch: prop.text("") } },
    { url: "https://www.notion.so/jd50", properties: { "Ticket ID": prop.id(50), Title: prop.title("Old"), Status: prop.status("QA Pending"), Sessions: prop.text(""), PR: prop.text(""), Branch: prop.text("") } },
  ];
  const tickets = rows.map((r) => parseTicketRow(r)!);
  assert.deepEqual(tickets[0], { id: "JD-57", title: "Agent graph", status: "In Progress", url: "https://www.notion.so/jd57", sessions: ["session_T1"], branch: "jd-57" });

  const tree = buildGraph(input({ sessions: [session("session_T1", "Build the graph")], tickets: new Map([["jarvis", tickets]]) }));
  const jarvis = project(tree, "jarvis");
  assert.deepEqual(ids(jarvis.loose), ["session:session_T1", "ticket:JD-58"], "QA Pending alone gets no node");
  const [t1, t58] = jarvis.loose;
  assert.deepEqual(t1.ticket, { id: "JD-57", title: "Agent graph", status: "In Progress", url: "https://www.notion.so/jd57" });
  assert.deepEqual(t1.sources, ["ticket"]);
  assert.equal(t58.kind, "ticket");
  assert.equal(t58.pr?.number, 90);
});

test("title fallback: `<ID>: …` joins that ticket (project from the ticket, else the prefix); tags still win", () => {
  const tree = buildGraph(
    input({
      sessions: [
        session("session_A", "JD-60: Orb glow"),
        session("session_B", "TR-9: Budget sheet"),
        session("session_C", "XX-1: no such project"),
        session("session_D", "JD-61: title says 61", { tags: ["project:jarvis", "ticket:JD-62"] }),
      ],
    }),
  );
  assert.deepEqual(ids(project(tree, "jarvis").loose), ["session:session_A", "session:session_D"]);
  assert.equal(project(tree, "jarvis").loose[0].ticket?.id, "JD-60");
  assert.deepEqual(project(tree, "jarvis").loose[0].sources, ["title"]);
  assert.equal(project(tree, "jarvis").loose[1].ticket?.id, "JD-62", "the tag beats the title");
  assert.deepEqual(ids(project(tree, "trip").loose), ["session:session_B"]);
  assert.ok(!JSON.stringify(tree).includes("session_C"));
});

test("finished runs older than 7 days fold into the project unless all=1", () => {
  const done = (costUsd: number) => ({ tags: ["project:jarvis", "role:orchestrator"], finished: true, statusBucket: "completed", costUsd });
  const sessions = [
    { ...session("session_old", "Batch 1", done(10)), lastActivity: new Date(NOW - FOLD_AFTER_MS - 60_000).toISOString() },
    { ...session("session_new", "Batch 9", done(1)), lastActivity: ago(60) },
    session("session_live", "Batch 10", { tags: ["project:jarvis", "role:orchestrator"] }),
  ];
  const tree = buildGraph(input({ sessions }));
  const jarvis = project(tree, "jarvis");
  assert.deepEqual(
    jarvis.orchestrators.map((o) => [o.session.id, o.finished]),
    [
      ["session_live", false],
      ["session_new", true],
    ],
  );
  assert.equal(jarvis.folded, 1);
  assert.equal(jarvis.metrics.costUsd, 11, "folded runs still count in the project's totals");
  assert.equal(project(buildGraph(input({ sessions, all: true })), "jarvis").orchestrators.length, 3);
});

test("CI: check runs map to queued / running / passed / failed; failed beats running beats queued", () => {
  assert.equal(checkState("queued"), "queued");
  assert.equal(checkState("waiting"), "queued");
  assert.equal(checkState("in_progress"), "running");
  assert.equal(checkState("completed", "success"), "passed");
  assert.equal(checkState("completed", "skipped"), "passed");
  assert.equal(checkState("completed", "failure"), "failed");
  assert.equal(checkState("completed", "timed_out"), "failed");
  const checks = parseCheckRuns({
    check_runs: [
      { name: "server", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/runs/1", started_at: "2026-10-17T03:00:00Z" },
      // A re-run of the same check: the newest one counts.
      { name: "server", status: "completed", conclusion: "success", html_url: "https://github.com/o/r/runs/2", started_at: "2026-10-17T03:10:00Z" },
      { name: "desk", status: "in_progress", conclusion: null, html_url: "https://github.com/o/r/runs/3" },
    ],
  });
  assert.deepEqual(checks, [
    { name: "desk", status: "in_progress", url: "https://github.com/o/r/runs/3", state: "running" },
    { name: "server", status: "completed", conclusion: "success", url: "https://github.com/o/r/runs/2", state: "passed" },
  ]);
  assert.equal(ciState(checks), "running");
  assert.equal(ciState([...checks, { name: "e2e", status: "completed", conclusion: "failure", state: "failed" }]), "failed");
  assert.equal(ciState([{ name: "a", status: "queued", state: "queued" }, { name: "b", status: "completed", state: "passed" }]), "queued");
  assert.equal(ciState([]), undefined);
});

/** A fake GitHub: PRs and check runs per head; counts every call; checks the token header. */
function fakeGitHub(token?: string) {
  const state = { checks: [{ name: "server", status: "in_progress", conclusion: null as string | null }], merged: false, calls: [] as string[], auth: [] as (string | null)[] };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    state.calls.push(url.pathname);
    state.auth.push(new Headers(init?.headers).get("authorization"));
    if (/\/pulls\/63$/.test(url.pathname)) {
      return new Response(JSON.stringify({ state: state.merged ? "closed" : "open", merged_at: state.merged ? ago(0) : null, title: "feat(JD-47)", head: { sha: "abc123" } }), { status: 200 });
    }
    if (url.pathname.endsWith("/commits/abc123/check-runs")) return new Response(JSON.stringify({ check_runs: state.checks }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { state, fetchImpl, token };
}

test("CI cadence (fake clock): every 30 s while a check runs, every 5 min once all are done, never after merge", async () => {
  let now = NOW;
  const gh = fakeGitHub();
  const ci = new CiPoller({ fetchImpl: gh.fetchImpl, now: () => now, token: "ghp_secret" });
  const pr = { number: 63, url: "https://github.com/o/r/pull/63", repo: "o/r", state: "open" as const };
  const pulls = () => gh.state.calls.filter((c) => c.endsWith("/pulls/63")).length;

  let out = await ci.refresh([pr]);
  assert.equal(out.get(pr.url)?.ci?.state, "running");
  assert.equal(out.get(pr.url)?.title, "feat(JD-47)");
  assert.equal(gh.state.auth[0], "Bearer ghp_secret");
  assert.equal(ci.interval, CI_ACTIVE_MS);
  now += CI_ACTIVE_MS - 1000;
  await ci.refresh([pr]);
  assert.equal(pulls(), 1, "not yet due");
  now += 1000;
  gh.state.checks = [{ name: "server", status: "completed", conclusion: "success" }];
  out = await ci.refresh([pr]);
  assert.equal(pulls(), 2);
  assert.equal(out.get(pr.url)?.ci?.state, "passed");
  assert.equal(ci.interval, CI_IDLE_MS);
  now += CI_ACTIVE_MS;
  await ci.refresh([pr]);
  assert.equal(pulls(), 2, "all passed: no read at 30 s");
  now += CI_IDLE_MS - CI_ACTIVE_MS;
  gh.state.merged = true;
  out = await ci.refresh([pr]);
  assert.equal(pulls(), 3, "read again at 5 min");
  assert.equal(out.get(pr.url)?.state, "merged");
  now += CI_IDLE_MS * 3;
  await ci.refresh([pr]);
  assert.equal(pulls(), 3, "a merged PR isn't read again");

  // Without a token: no auth header (public repos).
  const anon = fakeGitHub();
  await new CiPoller({ fetchImpl: anon.fetchImpl, now: () => now }).refresh([pr]);
  assert.equal(anon.state.auth[0], null);
});

test("agents.changed fires once per change (with the changed ids), not per poll; failures keep the last good data", async () => {
  let now = NOW;
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const gh = fakeGitHub();
  const metrics = (bucket: string, cost: number): SessionMetrics => ({ tags: ["project:jarvis", "role:orchestrator", "orchestrator:x", `run:${RUN}`], statusBucket: bucket, costUsd: cost, checkedAt: ago(0) });
  let orchMetrics = metrics("working", 1);
  let fail = false;
  const cell = (t: string) => [{ plain_text: t }];
  const row = (...cells: string[]) => ({ block: { type: "table_row", table_row: { cells: cells.map(cell) } }, children: [] });
  let notionCalls = 0;
  const notion: NotionReader = {
    rawPage: async () => {
      notionCalls++;
      if (fail) throw new Error("Notion 502");
      return { url: "https://www.notion.so/run", properties: { title: { type: "title", title: [{ plain_text: "Run: JARVIS batch 12 (2026-10-17)" }] } } };
    },
    rawBlocks: async () => [
      { block: { type: "heading_2", heading_2: { rich_text: cell("Builders") } }, children: [] },
      { block: { type: "table" }, children: [row("Ticket", "Kind", "Session / worktree", "State", "PR", "Started", "Updated"), row("JD-47", "sub-agent", "/home/user/va-jd47", "CI", "#63", "03:10", "03:52")] },
    ],
    queryRows: async (source, filter) => {
      assert.equal(source, PROJECTS[0].tickets);
      assert.deepEqual((filter.or as unknown[]).length, 3);
      return [];
    },
  };
  const graph = new AgentGraph({
    bus,
    projects: PROJECTS,
    sessions: async () => ({ sessions: [{ ...session("session_O", "Orchestrator"), metrics: orchMetrics }] }),
    notion,
    ci: new CiPoller({ fetchImpl: gh.fetchImpl, now: () => now }),
    now: () => now,
  });

  const first = await graph.get();
  assert.equal(events.length, 0, "the first read is no change");
  const sub = project(first, "jarvis").orchestrators[0].builders[0];
  assert.equal(sub.ci?.state, "running");
  assert.equal(sub.pr?.title, "feat(JD-47)");

  // Polls with nothing new: no event (cost moving doesn't count).
  for (let i = 0; i < 3; i++) {
    now += 30_000;
    orchMetrics = metrics("working", 1 + i);
    await graph.refresh();
  }
  assert.equal(events.length, 0);

  // CI finishes: one event naming the builder.
  gh.state.checks = [{ name: "server", status: "completed", conclusion: "failure" }];
  now += 30_000;
  await graph.refresh();
  now += 30_000;
  await graph.refresh();
  assert.deepEqual(events, [{ type: "agents.changed", ids: [`sub:${RUN}:JD-47`] }]);
  assert.equal(project(await graph.get(), "jarvis").orchestrators[0].builders[0].ci?.state, "failed");

  // The orchestrator's status changes: one more event.
  orchMetrics = metrics("blocked", 9);
  now += 30_000;
  await graph.refresh();
  await graph.refresh();
  assert.equal(events.length, 2);
  assert.deepEqual((events[1] as { ids: string[] }).ids, ["session:session_O"]);

  // Notion fails: the run page's last good builders stay, with a warning.
  fail = true;
  now += 120_000;
  const before = notionCalls;
  const tree = await graph.get();
  assert.ok(notionCalls > before);
  assert.equal(project(tree, "jarvis").orchestrators[0].builders.length, 1);
  assert.match(tree.warnings.join("\n"), /Run page .*Notion 502/);
  assert.equal(events.length, 2);
});

test("Notion.queryRows: a collection:// source uses the data sources API; a database id the database one", async () => {
  const calls: { url: string; version: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, version: new Headers(init.headers).get("notion-version"), body: JSON.parse(String(init.body)) });
    const page = calls.length === 1 ? { results: [{ id: "a" }], has_more: true, next_cursor: "c2" } : { results: [{ id: "b" }], has_more: false };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  const notion = new Notion("secret", fetchImpl);
  const rows = await notion.queryRows("collection://97df4bde-6ac0-42d6-a1cc-0b0838864dfb", { property: "Status" });
  assert.deepEqual(rows, [{ id: "a" }, { id: "b" }]);
  assert.equal(calls[0].url, "https://api.notion.com/v1/data_sources/97df4bde-6ac0-42d6-a1cc-0b0838864dfb/query");
  assert.equal(calls[0].version, "2025-09-03");
  assert.equal(calls[1].body.start_cursor, "c2");
  await notion.queryRows("9f7eaaea-cf7b-4331-a787-1e7f56a31a38", {});
  assert.equal(calls[2].url, "https://api.notion.com/v1/databases/9f7eaaeacf7b4331a7871e7f56a31a38/query");
  assert.equal(calls[2].version, "2022-06-28");
});

test("signatures: a new builder changes its orchestrator and adds its own id", () => {
  const base = input({ sessions: [session("session_O", "O", { tags: ["project:jarvis", "role:orchestrator"] })] });
  const before = signatures(buildGraph(base));
  const after = signatures(buildGraph({ ...base, sessions: [...base.sessions, session("session_N", "N", { tags: ["project:jarvis", "orchestrator:session_O"] })] }));
  assert.deepEqual(changedIds(before, after), ["session:session_N", "session:session_O"]);
  assert.deepEqual(changedIds(after, before), ["session:session_N", "session:session_O"]);
});

test("GET /api/desk/agents answers the tree (all=1 passes through)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-agents-"));
  const jarvis = new Jarvis({ dataDir: dir, claudeBin: "claude", dashboardPort: 0 } as unknown as Config, new Store(dir));
  const bus = new EventBus();
  const seen: boolean[] = [];
  const graph = new AgentGraph({ bus, projects: PROJECTS, sessions: async () => ({ sessions: [] }), ci: new CiPoller({ fetchImpl: (async () => new Response("{}")) as typeof fetch }) });
  const get = graph.get.bind(graph);
  graph.get = (all = false) => {
    seen.push(all);
    return get(all);
  };
  useAgentGraph(jarvis, graph);
  const ctx: DeskContext = { jarvis, bus, devices: new DeviceStore(dir), hub: new SseHub(bus), rpc: new DeskRpc(bus) };
  const server = createDashboard(jarvis, { desk: { router: await DeskRouter.discover(), ctx } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    ctx.hub.close();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desk`;
  const { key } = await ctx.devices.pair("Mac");
  const headers = { authorization: `Bearer ${key}` };
  assert.equal((await fetch(`${base}/agents`)).status, 401);
  const tree = (await (await fetch(`${base}/agents`, { headers })).json()) as AgentsResponse;
  assert.deepEqual(
    tree.projects.map((p) => [p.slug, p.name, p.orchestrators.length]),
    [
      ["jarvis", "JARVIS Desk", 0],
      ["trip", "Trip planner", 0],
    ],
  );
  await fetch(`${base}/agents?all=1`, { headers });
  assert.deepEqual(seen, [false, true]);
});

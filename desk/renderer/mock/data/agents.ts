// The agent graph (JD-57), typed as the server's AgentsResponse, for the Agents window (JD-58):
// JARVIS Desk with a cloud run of three builders (one building, one with CI running, one with CI
// failed), a run of local sub-agents and a loose session; Trip planner with a run its builders hang
// under by lineage and a ticket in progress with no session. Times are relative to when the preview
// loads, like the sessions mock.
import type {
  AgentBuilder,
  AgentCheck,
  AgentCi,
  AgentMetrics,
  AgentOrchestrator,
  AgentProject,
  AgentSession,
  AgentsResponse,
  CiState,
  SessionMetrics,
} from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const loaded = Date.now();
const ago = (min: number) => new Date(loaded - min * 60_000).toISOString();
const REPO = "MattSharp05/VirtualAssistant";
const RUN_13 = "3fc24983f3ca81aa9c1e00000000b013";
const RUN_12 = "3fc24983f3ca81aa9c1e00000000b012";
const RUN_TRIP = "3fc24983f3ca81aa9c1e0000000a7203";

function session(
  id: string,
  title: string,
  createdMin: number,
  costUsd: number,
  totalTokens: number,
  rest: Partial<SessionMetrics> = {},
): AgentSession {
  return {
    id,
    title,
    url: `https://claude.ai/code/${id}`,
    status: "running",
    lastActivity: ago(2),
    metrics: {
      costUsd,
      totalTokens,
      model: "claude-opus-5-5",
      statusBucket: "working",
      createdAt: ago(createdMin),
      updatedAt: ago(2),
      wallMs: createdMin * 60_000,
      finished: false,
      checkedAt: ago(0),
      ...rest,
    },
  };
}

const check = (name: string, state: CiState, run: number): AgentCheck => ({
  name,
  status: state === "running" ? "in_progress" : state === "queued" ? "queued" : "completed",
  ...(state === "passed" ? { conclusion: "success" } : state === "failed" ? { conclusion: "failure" } : {}),
  url: `https://github.com/${REPO}/actions/runs/${run}`,
  state,
});

const ci = (state: CiState, checks: AgentCheck[], sha: string): AgentCi => ({
  state,
  checks,
  headSha: sha,
  checkedAt: ago(0),
});

const pr = (number: number, title: string, state: "open" | "merged" = "open", repo = REPO) => ({
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  repo,
  state,
  title,
});

const ticket = (id: string, title: string, status: string) => ({
  id,
  title,
  status,
  url: `https://app.notion.com/p/${id.toLowerCase()}`,
});

// ── JARVIS Desk, batch 13: a cloud run with three builders ──

const orch13 = session("session_01JDorch13", "JARVIS batch 13 orchestrator", 95, 3.42, 4_810_000, {
  tags: ["project:jarvis", "role:orchestrator", `run:${RUN_13}`],
  contextPercent: 62.4,
});

const batch13: AgentBuilder[] = [
  {
    id: "session:session_01JD54",
    kind: "cloud",
    session: session("session_01JD54", "JD-54: Sessions window metrics", 80, 5.1, 9_220_000, {
      tags: ["project:jarvis", "role:builder", "orchestrator:session_01JDorch13", "ticket:JD-54"],
      parentId: "session_01JDorch13",
    }),
    state: "building",
    ticket: ticket("JD-54", "Sessions window: tokens, cost and context per session", "In Progress"),
    startedAt: ago(80),
    updatedAt: ago(4),
    sources: ["tags", "lineage", "run-page", "ticket"],
  },
  {
    id: "session:session_01JD55",
    kind: "cloud",
    session: session("session_01JD55", "JD-55: System window usage", 78, 6.84, 12_400_000, {
      tags: ["project:jarvis", "role:builder", "orchestrator:session_01JDorch13", "ticket:JD-55"],
      statusBucket: "review_ready",
    }),
    state: "ci",
    ticket: ticket("JD-55", "System window: plan usage by session", "In Review"),
    pr: pr(71, "feat(JD-55): System window usage by session"),
    ci: ci("running", [check("desk", "passed", 9101), check("server", "running", 9102)], "a1b2c3d"),
    startedAt: ago(78),
    updatedAt: ago(1),
    sources: ["tags", "run-page", "ticket"],
  },
  {
    id: "session:session_01JD57",
    kind: "cloud",
    session: session("session_01JD57", "JD-57: Agent graph on the server", 75, 8.97, 15_030_000, {
      tags: ["project:jarvis", "role:builder", "orchestrator:session_01JDorch13", "ticket:JD-57"],
      statusBucket: "blocked",
    }),
    state: "ci",
    ticket: ticket("JD-57", "Agent graph on the server: projects → orchestrators → builders", "In Review"),
    pr: pr(72, "feat(JD-57): agent graph"),
    ci: ci("failed", [check("desk", "passed", 9201), check("server", "failed", 9202)], "e4f5a6b"),
    startedAt: ago(75),
    updatedAt: ago(9),
    sources: ["tags", "run-page", "ticket"],
  },
];

// ── JARVIS Desk, batch 12: local sub-agents (only the run page knows them) ──

const orch12 = session("session_01JDorch12", "JARVIS batch 12 orchestrator", 300, 9.6, 14_200_000, {
  tags: ["project:jarvis", "role:orchestrator", `run:${RUN_12}`],
  statusBucket: "review_ready",
  contextPercent: 88.1,
});

const batch12: AgentBuilder[] = [
  {
    id: `sub:${RUN_12}:JD-47`,
    kind: "sub-agent",
    worktree: "/home/user/va-jd47",
    state: "merged",
    ticket: ticket("JD-47", "Camera hands: move, resize and minimise windows", "QA Pending"),
    pr: pr(63, "feat(JD-47): camera hands on windows", "merged"),
    ci: ci("passed", [check("desk", "passed", 8801), check("server", "passed", 8802)], "0c0ffee"),
    startedAt: ago(290),
    updatedAt: ago(250),
    sources: ["run-page", "ticket"],
  },
  {
    id: `sub:${RUN_12}:JD-48`,
    kind: "sub-agent",
    worktree: "/home/user/va-jd48",
    state: "ci",
    ticket: ticket("JD-48", "Voice latency: per-turn timings and tuning", "In Review"),
    pr: pr(64, "feat(JD-48): voice latency"),
    ci: ci("queued", [check("desk", "queued", 8901), check("server", "queued", 8902)], "5eed5ed"),
    startedAt: ago(285),
    updatedAt: ago(6),
    sources: ["run-page", "ticket"],
  },
];

const loose: AgentBuilder[] = [
  {
    id: "session:session_01JDloose",
    kind: "cloud",
    session: session("session_01JDloose", "Try the dashboard's dark theme", 30, 0.84, 1_100_000, {
      tags: ["project:jarvis"],
      statusBucket: "completed",
      finished: true,
    }),
    sources: ["tags"],
  },
];

// ── Trip planner: builders found by lineage, and a ticket nobody has picked up in a session ──

const tripOrch = session("session_01TRorch", "Trip planner orchestrator", 180, 4.2, 6_400_000, {
  tags: ["project:trip", "role:orchestrator", `run:${RUN_TRIP}`],
  contextPercent: 41,
});

const tripBuilders: AgentBuilder[] = [
  {
    id: "session:session_01TR20",
    kind: "cloud",
    session: session("session_01TR20", "TR-20: Hotel search", 120, 3.3, 5_050_000, {
      parentId: "session_01TRorch",
      statusBucket: "review_ready",
    }),
    ticket: ticket("TR-20", "Hotel search with budget filter", "In Review"),
    pr: pr(12, "feat(TR-20): hotel search", "open", "MattSharp05/trip"),
    ci: ci("passed", [check("test", "passed", 701)], "7a7a7a7"),
    sources: ["lineage", "title", "ticket"],
  },
];

const tripLoose: AgentBuilder[] = [
  {
    id: "ticket:TR-22",
    kind: "ticket",
    ticket: ticket("TR-22", "Itinerary export to PDF", "In Progress"),
    sources: ["ticket"],
  },
];

// Totals the way the server adds them up.
const DONE = ["merged", "stopped"];
function metrics(own: AgentSession[], builders: AgentBuilder[]): AgentMetrics {
  const sessions = [...own, ...builders.flatMap((b) => (b.session ? [b.session] : []))];
  const active = builders.filter((b) =>
    b.kind === "ticket"
      ? b.ticket?.status === "In Progress"
      : !DONE.includes(b.state ?? "") && !b.session?.metrics?.finished,
  ).length;
  return {
    sessions: sessions.length,
    builders: builders.length,
    active,
    costUsd: Math.round(sessions.reduce((n, s) => n + (s.metrics?.costUsd ?? 0), 0) * 100) / 100,
    totalTokens: sessions.reduce((n, s) => n + (s.metrics?.totalTokens ?? 0), 0),
  };
}

const sum = (list: AgentMetrics[]): AgentMetrics => ({
  sessions: list.reduce((n, m) => n + m.sessions, 0),
  builders: list.reduce((n, m) => n + m.builders, 0),
  active: list.reduce((n, m) => n + m.active, 0),
  costUsd: Math.round(list.reduce((n, m) => n + (m.costUsd ?? 0), 0) * 100) / 100,
  totalTokens: list.reduce((n, m) => n + (m.totalTokens ?? 0), 0),
});

const orchestrator = (
  s: AgentSession,
  builders: AgentBuilder[],
  run: { id: string; title: string; status: string },
): AgentOrchestrator => ({
  id: `session:${s.id}`,
  session: s,
  metrics: metrics([s], builders),
  run: { ...run, url: `https://app.notion.com/p/${run.id}` },
  finished: false,
  builders,
});

const jarvisOrchs = [
  orchestrator(orch13, batch13, {
    id: RUN_13,
    title: "Run: JARVIS batch 13 (2026-10-17)",
    status: "Running",
  }),
  orchestrator(orch12, batch12, {
    id: RUN_12,
    title: "Run: JARVIS batch 12 (2026-10-16)",
    status: "Waiting on user",
  }),
];
const tripOrchs = [
  orchestrator(tripOrch, tripBuilders, {
    id: RUN_TRIP,
    title: "Run: Trip v2 batch 3 (2026-10-17)",
    status: "Running",
  }),
];

export const projects: AgentProject[] = [
  {
    id: "project:jarvis",
    slug: "jarvis",
    name: "JARVIS Desk",
    notionUrl: "https://app.notion.com/p/3f924983f3ca810daa8ac980d7d4fab7",
    repo: REPO,
    metrics: sum([...jarvisOrchs.map((o) => o.metrics), metrics([], loose)]),
    orchestrators: jarvisOrchs,
    loose,
    folded: 2,
  },
  {
    id: "project:trip",
    slug: "trip",
    name: "Trip planner",
    repo: "MattSharp05/trip",
    metrics: sum([...tripOrchs.map((o) => o.metrics), metrics([], tripLoose)]),
    orchestrators: tripOrchs,
    loose: tripLoose,
    folded: 0,
  },
];

export const agents: AgentsResponse = { projects, warnings: [], checkedAt: ago(0) };

const part: ScenarioPart = { data: { "/agents": agents } };
export default part;

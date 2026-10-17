// The agent graph (JD-57) for the Agents window (JD-58): the full fixture, configured projects with
// nothing running (and Notion off), the first load still on its way, no projects at all, a run whose
// CI failed in several checks, and a live update (agents.changed) a few seconds in.
import type { AgentBuilder, AgentsResponse } from "@jarvis/shared";
import { PENDING } from "../bridge";
import { activityData } from "../data/agents-activity";
import { agents } from "../data/agents";
import type { MockRoute, Scenario } from "../types";

const one = (name: string, description: string, response: AgentsResponse | typeof PENDING): Scenario => ({
  name,
  description,
  data: { "/agents": response, ...activityData },
  events: [],
});

const quiet: AgentsResponse = {
  projects: agents.projects.map((p) => ({
    ...p,
    metrics: { sessions: 0, builders: 0, active: 0 },
    orchestrators: [],
    loose: [],
    folded: 0,
  })),
  warnings: ["Notion is off (NOTION_TOKEN unset): no run pages or tickets."],
  checkedAt: agents.checkedAt,
};

const empty: AgentsResponse = { projects: [], warnings: [], checkedAt: agents.checkedAt };

/** A copy of the fixture with one builder changed (found by ticket ID). */
function withBuilder(ticket: string, change: (b: AgentBuilder) => void) {
  const copy = structuredClone(agents);
  for (const p of copy.projects)
    for (const b of [...p.orchestrators.flatMap((o) => o.builders), ...p.loose])
      if (b.ticket?.id === ticket) change(b);
  return copy;
}

const checkUrl = (run: number) => `https://github.com/MattSharp05/VirtualAssistant/actions/runs/${run}`;

// Batch 13 with CI red twice: JD-57 fails server and e2e, JD-55 fails lint.
const ciFailed = withBuilder("JD-57", (b) => {
  b.ci = {
    state: "failed",
    headSha: "e4f5a6b",
    checkedAt: agents.checkedAt,
    checks: [
      { name: "desk", status: "completed", conclusion: "success", state: "passed", url: checkUrl(9201) },
      { name: "server", status: "completed", conclusion: "failure", state: "failed", url: checkUrl(9202) },
      {
        name: "e2e (web-desktop)",
        status: "completed",
        conclusion: "failure",
        state: "failed",
        url: checkUrl(9203),
      },
      { name: "typecheck", status: "completed", conclusion: "success", state: "passed", url: checkUrl(9204) },
    ],
  };
});
for (const p of ciFailed.projects)
  for (const b of p.orchestrators.flatMap((o) => o.builders))
    if (b.ticket?.id === "JD-55")
      b.ci = {
        state: "failed",
        headSha: "a1b2c3d",
        checkedAt: agents.checkedAt,
        checks: [
          { name: "desk", status: "completed", conclusion: "success", state: "passed", url: checkUrl(9101) },
          { name: "lint", status: "completed", conclusion: "failure", state: "failed", url: checkUrl(9105) },
        ],
      };

// After the live update JD-55's CI has passed.
const afterUpdate = withBuilder("JD-55", (b) => {
  b.ci = {
    state: "passed",
    headSha: "a1b2c3d",
    checkedAt: agents.checkedAt,
    checks: b.ci!.checks.map((c) => ({ ...c, status: "completed", conclusion: "success", state: "passed" })),
  };
});

/** The first GET /agents answers the fixture, every later one the updated graph. */
const liveRoute: MockRoute = (path, _body, ctx) => {
  if (path.split("?")[0] !== "/agents") return undefined;
  const reads = ((ctx.data.__agentsReads as number | undefined) ?? 0) + 1;
  ctx.data.__agentsReads = reads;
  return reads === 1 ? agents : afterUpdate;
};

/** When the live scenario's agents.changed arrives (e2e advances a fake clock past it). */
export const LIVE_UPDATE_MS = 5000;

const scenarios: Scenario[] = [
  one(
    "agents",
    "Agents: JARVIS Desk with a 3-builder cloud run (building, CI running, CI failed), a sub-agent run and a loose session; Trip planner with a lineage run and a ticket alone.",
    agents,
  ),
  one("agents-quiet", "Agents: two configured projects, nothing running, and a Notion-off warning.", quiet),
  one("agents-loading", "Agents while the first GET /agents is still on its way.", PENDING),
  one("agents-empty", "Agents: no projects configured, nothing to draw.", empty),
  one(
    "agents-ci-failed",
    "Agents: batch 13 with CI red twice: JD-57 fails server and e2e (2 of 4), JD-55 fails lint.",
    ciFailed,
  ),
  {
    ...one(
      "agents-live",
      "Agents: the fixture, then 5 s in an agents.changed turns JD-55's CI green (the card flashes).",
      agents,
    ),
    routes: [liveRoute],
    events: [{ after: LIVE_UPDATE_MS, event: { type: "agents.changed", ids: ["session:session_01JD55"] } }],
  },
];

export default scenarios;

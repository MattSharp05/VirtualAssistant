// The agent graph (JD-57) for the Agents window (JD-58): the full fixture, configured projects with
// nothing running (and Notion off), and the first load still on its way.
import type { AgentsResponse } from "@jarvis/shared";
import { PENDING } from "../bridge";
import { agents } from "../data/agents";
import type { Scenario } from "../types";

const one = (name: string, description: string, response: AgentsResponse | typeof PENDING): Scenario => ({
  name,
  description,
  data: { "/agents": response },
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

const scenarios: Scenario[] = [
  one(
    "agents",
    "Agents: JARVIS Desk with a 3-builder cloud run (building, CI running, CI failed), a sub-agent run and a loose session; Trip planner with a lineage run and a ticket alone.",
    agents,
  ),
  one("agents-quiet", "Agents: two configured projects, nothing running, and a Notion-off warning.", quiet),
  one("agents-loading", "Agents while the first GET /agents is still on its way.", PENDING),
];

export default scenarios;

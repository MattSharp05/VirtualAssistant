// The Agents window with four projects (JD-75): the fixture's JARVIS Desk (working) and Trip planner
// (a builder ready for QA, so it waits), plus mk with a run waiting on Matthew and Gogentic site with
// nothing running. Bands, jump chips and the minimap's tints all show up here.
import type { AgentBuilder, AgentProject, AgentSession, AgentsResponse } from "@jarvis/shared";
import { activityData } from "../data/agents-activity";
import { agents } from "../data/agents";
import type { Scenario } from "../types";

const loaded = Date.now();
const ago = (min: number) => new Date(loaded - min * 60_000).toISOString();

function session(id: string, title: string, costUsd: number, bucket: string, rest = {}): AgentSession {
  return {
    id,
    title,
    url: `https://claude.ai/code/${id}`,
    status: "running",
    lastActivity: ago(3),
    metrics: {
      costUsd,
      totalTokens: Math.round(costUsd * 1_500_000),
      model: "claude-opus-5-5",
      statusBucket: bucket as "working",
      createdAt: ago(240),
      updatedAt: ago(3),
      wallMs: 240 * 60_000,
      finished: false,
      checkedAt: ago(0),
      ...rest,
    },
  };
}

const MK_RUN = "3fc24983f3ca81aa9c1e00000000c081";
const mkOrch = session("session_01MKorch", "mk lineage orchestrator", 38.1, "blocked", {
  tags: ["project:mk", "role:orchestrator", `run:${MK_RUN}`],
  contextPercent: 88,
});
const mkBuilders: AgentBuilder[] = [
  {
    id: "session:session_01MK81",
    kind: "cloud",
    session: session("session_01MK81", "MK-81: Drift boost cap", 2.6, "blocked", {
      parentId: "session_01MKorch",
    }),
    ticket: {
      id: "MK-81",
      title: "Drift boost cap",
      status: "In Progress",
      url: "https://app.notion.com/p/mk-81",
    },
    sources: ["lineage", "ticket"],
  },
  {
    id: "session:session_01MK79",
    kind: "cloud",
    session: session("session_01MK79", "MK-79: Leaderboard paging", 1.2, "working", {
      parentId: "session_01MKorch",
    }),
    ticket: { id: "MK-79", title: "Leaderboard paging", status: "In Progress" },
    sources: ["lineage", "ticket"],
  },
];

const mk: AgentProject = {
  id: "project:mk",
  slug: "mk",
  name: "mk",
  repo: "MattSharp05/mk",
  metrics: { sessions: 3, builders: 2, active: 2, costUsd: 41.9, totalTokens: 62_850_000 },
  orchestrators: [
    {
      id: "session:session_01MKorch",
      session: mkOrch,
      metrics: { sessions: 3, builders: 2, active: 2, costUsd: 41.9, totalTokens: 62_850_000 },
      run: {
        id: MK_RUN,
        url: `https://app.notion.com/p/${MK_RUN}`,
        title: "Run: mk lineage (2026-10-17)",
        status: "Waiting on user",
      },
      finished: false,
      builders: mkBuilders,
    },
  ],
  loose: [],
  folded: 0,
};

const gogentic: AgentProject = {
  id: "project:gogentic",
  slug: "gogentic",
  name: "Gogentic site",
  repo: "MattSharp05/gogentic-site",
  metrics: { sessions: 0, builders: 0, active: 0 },
  orchestrators: [],
  loose: [],
  folded: 0,
};

export const manyProjects: AgentsResponse = {
  projects: [...agents.projects, mk, gogentic],
  warnings: [],
  checkedAt: agents.checkedAt,
};

const scenario: Scenario = {
  name: "agents-projects",
  description:
    "Agents: four projects in bands (JARVIS Desk working, Trip planner and mk waiting on you, Gogentic site quiet), with jump chips and the overview map.",
  data: { "/agents": manyProjects, ...activityData },
  events: [],
};

export default scenario;

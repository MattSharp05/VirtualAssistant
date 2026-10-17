// The System window's project totals and 30-day history (JD-55): a month with eight projects (the
// three smallest fold into "Other" in the chart), and a server that hasn't taken a snapshot yet.
import type { SystemResponse } from "@jarvis/shared";
import { system } from "../data/system";
import { demoProjects, usageFor, type MockProject } from "../data/system-usage";
import type { Scenario } from "../types";

const H = 3_600_000;
const small = (project: string, cost: (i: number) => number, earlier = 0): MockProject => ({
  project,
  cost,
  tokensPerUsd: 2_000_000,
  activeSessions: 0,
  earlier: {
    costUsd: earlier,
    sessions: earlier ? 1 : 0,
    wallMs: earlier ? 4 * H : 0,
    activeMs: earlier ? H : 0,
  },
  week: { sessions: 1, wallMs: 3 * H, activeMs: H },
  sessions: 2,
});

/** The demo month plus four smaller projects: a launch spike on day 27 and a few one-off days. */
const busy = usageFor([
  ...demoProjects,
  small("landing-site", (i) => (i === 26 ? 38 : i > 24 ? 6 : 0)),
  small("dotfiles", (i) => (i % 9 === 3 ? 2.2 : 0), 3),
  small("recipes", (i) => (i === 8 || i === 9 ? 4.5 : 0)),
  small("notion-tidy", (i) => (i % 6 === 0 ? 0.6 : 0)),
]);

const fresh: Pick<SystemResponse, "projects" | "history"> = {
  projects: [],
  history: system.history!.map((d) => ({ day: d.day, costUsd: 0, tokens: 0, projects: {} })),
};

const scenarios: Scenario[] = [
  {
    name: "system-history",
    description:
      "System: 30 days of cloud session cost across nine projects (a launch spike on 11 Oct); the chart folds the smallest into Other.",
    data: { "/system": { ...system, ...busy } },
    events: [],
  },
  {
    name: "system-history-empty",
    description: "System before the server's first hourly snapshot: no projects, an empty 30-day chart.",
    data: { "/system": { ...system, ...fresh } },
    events: [],
  },
];

export default scenarios;

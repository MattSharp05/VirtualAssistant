// The Agents window's data (JD-57): every project with its orchestrators, their builders (cloud
// sessions and sub-agents), each builder's ticket, PR and CI.
//   GET /api/desk/agents[?all=1] → AgentsResponse (all=1 adds finished runs older than 7 days)
// agents.changed on the live stream says when it changed (src/agents/index.ts polls while a Desk is
// connected). View and open only: nothing here changes a session, ticket or PR.
import type { AgentsResponse } from "@jarvis/shared";
import { agentGraphFor } from "../../agents/index.js";
import type { DeskRoute } from "./index.js";

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/agents",
    handler: ({ url, ctx }): Promise<AgentsResponse> => agentGraphFor(ctx.jarvis, ctx.bus).get(/^(1|true|yes)$/i.test(url.searchParams.get("all") ?? "")),
  },
];

export default routes;
